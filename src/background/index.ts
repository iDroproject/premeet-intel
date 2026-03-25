// PreMeet background service worker
// Handles message routing between content script, popup, and side panel.
// Supports both the basic enrichment pipeline (MEETING_DETECTED) and the
// full waterfall enrichment pipeline (FETCH_PERSON_BACKGROUND).

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, ContentToBackground, PopupToBackground } from '../types';
import { enrichAttendee } from './enrichment';
import { hasCredit, useCredit, getCredits } from '../utils/credits';
import { WaterfallOrchestrator, CacheManager } from './enrichment/index';
import type { PersonData, ProgressPayload, SearchResult, CompanyData, ContactInfo } from './enrichment/types';
import { addLogEntry, getActivityLog } from '../utils/activityLog';
import type { ActivityLogEntry, DataSourceLabel } from '../types';
import { signInWithGoogle, signOut, getAuthState, getCurrentUser, authFetch } from '../lib/auth';
import { getSettings } from '../utils/settings';
import { createLogBuffer, log as debugLog } from '../utils/logger';

const LOG = '[PreMeet][SW]';
const waterfallLogBuffer = createLogBuffer('Enrichment');

// ─── Module-level Singletons ─────────────────────────────────────────────────

const cache = new CacheManager();

// ─── In-Memory State ─────────────────────────────────────────────────────────

let currentMeeting: MeetingEvent | null = null;
let currentEnriched: EnrichedAttendee[] = [];

// ─── Install ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log(LOG, 'PreMeet installed.');
});

// ─── Side Panel Setup ────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((err) => {
  console.warn(LOG, 'Failed to set side panel behavior:', err);
});

// ─── Message Handling ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: ContentToBackground | PopupToBackground,
    sender,
    sendResponse,
  ) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'MEETING_DETECTED') {
      handleMeetingDetected(msg.payload, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GET_CURRENT_MEETING') {
      sendResponse({ ok: true, meeting: currentMeeting, attendees: currentEnriched });
      return false;
    }

    if (msg.type === 'ENRICH_ATTENDEE') {
      handleEnrichSingleAttendee(msg.payload.email, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_PERSON_BACKGROUND') {
      handleFetchPersonBackground(msg.payload, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'SEARCH_PERSON') {
      handleSearchPerson(msg.payload, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'ENRICH_PERSON') {
      handleEnrichPerson(msg.payload, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_COMPANY_INTEL') {
      handleFetchCompanyIntel(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_CONTACT_INFO') {
      handleFetchContactInfo(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'CUSTOM_ENRICHMENT') {
      handleCustomEnrichment(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GET_CACHE_STATS') {
      cache.getStats().then((stats) => sendResponse({ ok: true, stats })).catch(() => sendResponse({ ok: false }));
      return true; // async response
    }

    if (msg.type === 'CLEAR_CACHE') {
      cache.clear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (msg.type === 'GET_ACTIVITY_LOG') {
      getActivityLog().then((entries) => sendResponse({ ok: true, entries })).catch(() => sendResponse({ ok: false }));
      return true;
    }

    // ─── Auth Messages ────────────────────────────────────────────────────
    if (msg.type === 'AUTH_SIGN_IN') {
      signInWithGoogle()
        .then((state) => sendResponse({ ok: true, ...state }))
        .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (msg.type === 'AUTH_SIGN_OUT') {
      signOut()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
      return true;
    }

    if (msg.type === 'AUTH_GET_STATE') {
      getAuthState()
        .then((state) => sendResponse({ ok: true, ...state }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (msg.type === 'AUTH_GET_USER') {
      getCurrentUser()
        .then((user) => sendResponse({ ok: true, user }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    return false;
  },
);

// ─── Activity Logging ────────────────────────────────────────────────────────

function resolveDataSources(personData: PersonData | null, fromCache: boolean): DataSourceLabel[] {
  if (fromCache) return ['Cache'];
  if (!personData) return [];
  const sources: DataSourceLabel[] = [];
  // Map internal _source to generic labels
  if (personData._source === 'scraper') sources.push('Profile Scraper');
  if (personData._source === 'filter') sources.push('Business Data');
  // If we have LinkedIn data, profile lookup/search was used
  if (personData.linkedinUrl) sources.push('Web Search', 'Profile Lookup');
  // Deduplicate
  return [...new Set(sources)];
}

function buildLogEntry(
  attendeeName: string,
  attendeeEmail: string,
  meetingTitle: string,
  status: 'done' | 'error',
  personData: PersonData | null,
  fromCache: boolean,
): ActivityLogEntry {
  let logStatus: ActivityLogEntry['status'];
  if (fromCache) {
    logStatus = 'cached';
  } else if (status === 'error') {
    logStatus = 'failed';
  } else if (personData && personData._confidence === 'low') {
    logStatus = 'partial';
  } else {
    logStatus = 'success';
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    attendeeName,
    attendeeEmail,
    status: logStatus,
    creditsUsed: fromCache ? 0 : 1,
    dataSources: resolveDataSources(personData, fromCache),
    meetingTitle,
  };
}

// ─── Waterfall Enrichment Pipeline ───────────────────────────────────────────

async function handleFetchPersonBackground(
  payload: { name: string; email: string; company: string },
  senderTabId?: number,
): Promise<void> {
  console.log(LOG, `Waterfall fetch for: "${payload.name}" <${payload.email}>`);
  debugLog('Background', 'info', `Waterfall fetch started for "${payload.name}" <${payload.email}>`);

  const orchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);

  orchestrator.onProgress = (progress: ProgressPayload) => {
    broadcastToPopups({ type: 'FETCH_PROGRESS', payload: progress });
  };

  orchestrator.onInterimResult = (data: PersonData) => {
    broadcastToPopups({ type: 'INTERIM_PERSON_DATA', payload: data });
  };

  try {
    const result = await orchestrator.fetch(payload);
    broadcastToPopups({ type: 'PERSON_BACKGROUND_RESULT', payload: result });
    console.log(LOG, `Waterfall complete for "${payload.name}" — confidence: ${result._confidence}`);
  } catch (err) {
    console.error(LOG, 'Waterfall pipeline error:', err);
    broadcastToPopups({
      type: 'PERSON_BACKGROUND_RESULT',
      payload: { error: (err as Error).message },
    });
  }
}

// ─── Phase A: Lightweight Search (no credits) ──────────────────────────────

async function handleSearchPerson(
  payload: { name: string; email: string; company: string },
  senderTabId?: number,
): Promise<void> {
  console.log(LOG, `Search for: "${payload.name}" <${payload.email}>`);
  debugLog('Background', 'info', `Search started for "${payload.name}" <${payload.email}>`);

  const orchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);

  orchestrator.onProgress = (progress: ProgressPayload) => {
    broadcastToPopups({ type: 'FETCH_PROGRESS', payload: progress });
  };

  try {
    const result = await orchestrator.search(payload);
    broadcastToPopups({ type: 'SEARCH_PERSON_RESULT', payload: result });
    console.log(LOG, `Search complete for "${payload.name}" — linkedIn: ${result.linkedinUrl ? 'found' : 'not found'}`);
  } catch (err) {
    console.error(LOG, 'Search pipeline error:', err);
    broadcastToPopups({
      type: 'SEARCH_PERSON_RESULT',
      payload: { error: (err as Error).message },
    });
  }
}

// ─── Phase B: Full Enrichment (1 credit) ────────────────────────────────────

async function handleEnrichPerson(
  payload: { name: string; email: string; company: string; linkedInUrl: string },
  senderTabId?: number,
): Promise<void> {
  console.log(LOG, `Enrich for: "${payload.name}" <${payload.email}> (LinkedIn: ${payload.linkedInUrl})`);
  debugLog('Background', 'info', `Enrich started for "${payload.name}" <${payload.email}>`);

  const orchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);

  orchestrator.onProgress = (progress: ProgressPayload) => {
    broadcastToPopups({ type: 'FETCH_PROGRESS', payload: progress });
  };

  orchestrator.onInterimResult = (data: PersonData) => {
    broadcastToPopups({ type: 'INTERIM_PERSON_DATA', payload: data });
  };

  try {
    const result = await orchestrator.enrich(payload);
    broadcastToPopups({ type: 'ENRICH_PERSON_RESULT', payload: result });
    console.log(LOG, `Enrich complete for "${payload.name}" — confidence: ${result._confidence}`);
  } catch (err) {
    console.error(LOG, 'Enrich pipeline error:', err);
    broadcastToPopups({
      type: 'ENRICH_PERSON_RESULT',
      payload: { error: (err as Error).message },
    });
  }
}

// ─── Basic Enrichment Pipeline (MEETING_DETECTED) ───────────────────────────

async function handleMeetingDetected(meeting: MeetingEvent, senderTabId?: number): Promise<void> {
  console.log(LOG, `Meeting detected: "${meeting.title}" with ${meeting.attendees.length} attendee(s)`);

  currentMeeting = meeting;
  // Show attendees immediately as idle — no enrichment until user clicks a card
  currentEnriched = meeting.attendees.map((a) => ({
    ...a,
    person: null,
    enrichedAt: Date.now(),
    status: 'idle' as const,
  }));

  broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: currentEnriched } });

  if (senderTabId != null) {
    chrome.sidePanel.open({ tabId: senderTabId }).catch((err) => {
      console.warn(LOG, 'Could not auto-open side panel:', err);
    });
  }

  // Auto-search all attendees if setting is enabled
  try {
    const settings = await getSettings();
    if (settings.autoSearchAttendees) {
      autoSearchAllAttendees(senderTabId);
    }
  } catch (err) {
    console.warn(LOG, 'Failed to check autoSearchAttendees setting:', err);
  }
}

/**
 * Auto-enrich all attendees sequentially, skipping the current user.
 * Stops early if credits run out.
 */
async function autoSearchAllAttendees(senderTabId?: number): Promise<void> {
  if (!currentMeeting) return;

  // Get current user email to exclude from auto-search
  let currentUserEmail: string | null = null;
  try {
    const user = await getCurrentUser();
    currentUserEmail = user?.email?.toLowerCase() ?? null;
  } catch {
    console.warn(LOG, 'Could not get current user for auto-search filter');
  }

  const attendees = currentMeeting.attendees;
  console.log(LOG, `Auto-searching ${attendees.length} attendees (excluding ${currentUserEmail ?? 'unknown user'})`);

  // Filter to eligible attendees first
  const eligible = attendees.filter((attendee) => {
    if (currentUserEmail && attendee.email.toLowerCase() === currentUserEmail) return false;
    const existing = currentEnriched.find((a) => a.email.toLowerCase() === attendee.email.toLowerCase());
    if (existing && (existing.status === 'done' || existing.status === 'pending')) return false;
    return true;
  });

  if (eligible.length === 0) {
    console.log(LOG, 'Auto-search: no eligible attendees');
    return;
  }

  // Check credits upfront
  try {
    const creditAvailable = await hasCredit();
    if (!creditAvailable) {
      console.warn(LOG, 'Auto-search: no credits available.');
      const credits = await getCredits();
      const [y, m] = credits.resetMonth.split('-').map(Number);
      const nextReset = new Date(y, m, 1);
      const resetDate = nextReset.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      broadcastToPopups({ type: 'CREDITS_EXHAUSTED', payload: { meeting: currentMeeting!, resetDate } });
      return;
    }
  } catch (err) {
    console.error(LOG, 'Auto-search: credit check failed, stopping batch:', err);
    return;
  }

  // Enrich attendees in parallel with concurrency limit
  const CONCURRENCY = 3;
  console.log(LOG, `Auto-search: enriching ${eligible.length} attendees (concurrency=${CONCURRENCY})`);

  const enrichOne = async (attendee: typeof eligible[0]): Promise<void> => {
    // Re-check credits before each enrichment
    try {
      const creditAvailable = await hasCredit();
      if (!creditAvailable) {
        console.warn(LOG, 'Auto-search: credits exhausted mid-batch.');
        return;
      }
    } catch {
      return;
    }
    await handleEnrichSingleAttendee(attendee.email, senderTabId);
  };

  // Simple concurrency pool
  const queue = [...eligible];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const attendee = queue.shift();
      if (attendee) await enrichOne(attendee);
    }
  });

  await Promise.all(workers);

  console.log(LOG, `Auto-search complete for "${currentMeeting?.title}"`);
}

// ─── Single-Attendee On-Demand Enrichment ──────────────────────────────────

async function handleEnrichSingleAttendee(email: string, _senderTabId?: number): Promise<void> {
  if (!currentMeeting) return;

  const idx = currentEnriched.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return;

  // Skip if already enriching or done
  if (currentEnriched[idx].status === 'pending' || currentEnriched[idx].status === 'done') return;

  const attendee = currentMeeting.attendees[idx];
  console.log(LOG, `On-demand enrich for: "${attendee.name}" <${attendee.email}>`);
  debugLog('Background', 'info', `Enrichment started for "${attendee.name}" <${attendee.email}>`);

  // Mark as pending/searching
  currentEnriched[idx] = { ...currentEnriched[idx], status: 'pending', stage: 'searching' };
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  const orchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);

  // ── Phase A: Lightweight search (free, no credits) ──────────────────────
  let searchResult: SearchResult | null = null;
  try {
    searchResult = await orchestrator.search({
      name: attendee.name,
      email: attendee.email,
      company: attendee.company || '',
    });

    currentEnriched[idx] = {
      ...currentEnriched[idx],
      stage: 'fetching',
      searchResult,
      hasLinkedIn: !!searchResult.linkedinUrl,
    };
    broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });
  } catch (searchErr) {
    const errMsg = (searchErr as Error).message;
    console.error(LOG, `Search failed for ${email}:`, errMsg);
    debugLog('Background', 'error', `Search failed for ${email}: ${errMsg}`);
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'error',
      stage: 'complete',
      error: errMsg.includes('VITE_BRIGHTDATA_API_KEY')
        ? 'BrightData API key not configured. Set VITE_BRIGHTDATA_API_KEY in .env'
        : errMsg.includes('Not authenticated')
          ? 'Please sign in to use enrichment.'
          : `Search failed: ${errMsg}`,
    };
    broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

    const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting.title, 'error', null, false);
    addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));
    return;
  }

  if (!searchResult.linkedinUrl) {
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'error',
      stage: 'complete',
      error: 'Could not find LinkedIn profile.',
    };
    broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

    const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting.title, 'error', null, false);
    addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));
    return;
  }

  // ── Phase B: Full enrichment (1 credit) ─────────────────────────────────

  // Check credits before enrichment
  try {
    const creditAvailable = await hasCredit();
    if (!creditAvailable) {
      console.warn(LOG, 'No enrichment credits remaining.');
      const credits = await getCredits();
      const [y, m] = credits.resetMonth.split('-').map(Number);
      const nextReset = new Date(y, m, 1);
      const resetDate = nextReset.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      broadcastToPopups({ type: 'CREDITS_EXHAUSTED', payload: { meeting: currentMeeting, resetDate } });
      return;
    }
  } catch (err) {
    console.error(LOG, 'Credit check failed:', err);
    return;
  }

  currentEnriched[idx] = { ...currentEnriched[idx], stage: 'fetching' };
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  let personData: PersonData | null = null;
  try {
    const enrichOrchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);
    enrichOrchestrator.onInterimResult = (interim: PersonData) => {
      currentEnriched[idx] = {
        ...currentEnriched[idx],
        personData: interim,
        hasLinkedIn: !!interim.linkedinUrl,
        person: {
          name: interim.name,
          email: attendee.email,
          title: interim.currentTitle,
          company: interim.currentCompany ? {
            name: interim.currentCompany,
            domain: '',
            website: interim.companyWebsite,
            description: interim.companyDescription,
          } : null,
        },
      };
      broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });
    };
    personData = await enrichOrchestrator.enrich({
      name: attendee.name,
      email: attendee.email,
      company: attendee.company || '',
      linkedInUrl: searchResult.linkedinUrl,
    });
  } catch (enrichErr) {
    const errMsg = (enrichErr as Error).message;
    console.error(LOG, `Enrich failed for ${email}:`, errMsg);
    debugLog('Background', 'error', `Enrich failed for ${email}: ${errMsg}`);
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'error',
      stage: 'complete',
      error: `Enrichment failed: ${errMsg}`,
    };
  }

  if (personData) {
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'done',
      stage: 'complete',
      personData,
      hasLinkedIn: !!personData.linkedinUrl,
      fromCache: false,
      person: {
        name: personData.name,
        email: attendee.email,
        title: personData.currentTitle,
        company: personData.currentCompany ? {
          name: personData.currentCompany,
          domain: '',
          website: personData.companyWebsite,
          description: personData.companyDescription,
        } : null,
      },
    };
  }

  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  // Log and consume credit
  const ea = currentEnriched[idx];
  const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting.title, ea.status === 'error' ? 'error' : 'done', ea.personData ?? null, ea.fromCache ?? false);
  addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));

  await useCredit().catch((e) => console.warn(LOG, 'Failed to use credit:', e));

  // Check if all attendees are now enriched
  const allDone = currentEnriched.every((a) => a.status === 'done' || a.status === 'error');
  if (allDone) {
    notifyContentScript({ type: 'ENRICHMENT_COMPLETE' });
    debugLog('Background', 'info', `All attendees enriched for "${currentMeeting.title}"`);
    console.log(LOG, `All attendees enriched for "${currentMeeting.title}"`);
  }
}

// ─── Company Intel (on-demand, 1 credit) ─────────────────────────────────────

async function handleFetchCompanyIntel(
  payload: { email: string; companyName: string; linkedinUrl?: string; website?: string },
): Promise<void> {
  const { email, companyName, linkedinUrl, website } = payload;
  console.log(LOG, `Company intel fetch for: "${companyName}" (attendee: ${email})`);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) {
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${supabaseUrl}/functions/v1/enrichment-company`;
  const body: Record<string, string> = { companyName };
  if (linkedinUrl) body.linkedinUrl = linkedinUrl;
  if (website) body.website = website;

  try {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const errMsg = (errBody as { error?: string }).error || `HTTP ${res.status}`;
      console.error(LOG, `Company intel error for "${companyName}":`, errMsg);
      broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: CompanyData; cached: boolean };
    console.log(LOG, `Company intel complete for "${companyName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Company intel fetch failed for "${companyName}":`, errMsg);
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Contact Info (on-demand, Pro-gated, 1 credit) ────────────────────────────

async function handleFetchContactInfo(
  payload: { email: string; linkedinUrl: string; fullName: string; companyName?: string },
): Promise<void> {
  const { email, linkedinUrl, fullName, companyName } = payload;
  console.log(LOG, `Contact info fetch for: "${fullName}" (attendee: ${email})`);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) {
    broadcastToPopups({ type: 'CONTACT_INFO_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${supabaseUrl}/functions/v1/enrichment-contact`;
  const body: Record<string, string> = { linkedinUrl, fullName };
  if (companyName) body.companyName = companyName;

  try {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const errMsg = (errBody as { error?: string; message?: string }).message
        || (errBody as { error?: string }).error
        || `HTTP ${res.status}`;
      console.error(LOG, `Contact info error for "${fullName}":`, errMsg);
      broadcastToPopups({ type: 'CONTACT_INFO_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: ContactInfo; cached: boolean };
    console.log(LOG, `Contact info complete for "${fullName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'CONTACT_INFO_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Contact info fetch failed for "${fullName}":`, errMsg);
    broadcastToPopups({ type: 'CONTACT_INFO_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Custom Enrichment (on-demand, Pro-gated, 2 credits) ─────────────────────

async function handleCustomEnrichment(
  payload: { email: string; linkedinUrl: string; fullName: string; prompt: string },
): Promise<void> {
  const { email, linkedinUrl, fullName, prompt } = payload;
  console.log(LOG, `Custom enrichment for: "${fullName}" (attendee: ${email}) prompt: "${prompt}"`);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) {
    broadcastToPopups({ type: 'CUSTOM_ENRICHMENT_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${supabaseUrl}/functions/v1/enrichment-custom`;
  const body = { linkedinUrl, fullName, prompt };

  try {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      const errMsg = (errBody as { message?: string; error?: string }).message
        || (errBody as { error?: string }).error
        || `HTTP ${res.status}`;
      console.error(LOG, `Custom enrichment error for "${fullName}":`, errMsg);
      broadcastToPopups({ type: 'CUSTOM_ENRICHMENT_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: { results: unknown[]; summary: string }; cached: boolean };
    console.log(LOG, `Custom enrichment complete for "${fullName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'CUSTOM_ENRICHMENT_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Custom enrichment fetch failed for "${fullName}":`, errMsg);
    broadcastToPopups({ type: 'CUSTOM_ENRICHMENT_RESULT', payload: { email, error: errMsg } });
  }
}

function notifyContentScript(msg: object): void {
  chrome.tabs.query({ url: 'https://calendar.google.com/*' }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, msg, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  });
}

function broadcastToPopups(msg: object): void {
  chrome.runtime.sendMessage(msg, () => {
    void chrome.runtime.lastError;
  });
}
