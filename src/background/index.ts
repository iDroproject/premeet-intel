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

/** Maps raw pipeline errors to user-friendly messages. */
function friendlyErrorMessage(rawMsg: string): string {
  if (rawMsg.includes('VITE_BRIGHTDATA_API_KEY'))
    return 'BrightData API key not configured. Set VITE_BRIGHTDATA_API_KEY in .env';
  if (rawMsg.includes('Not authenticated'))
    return 'Please sign in to use enrichment.';
  if (/timed out/i.test(rawMsg))
    return 'The lookup took too long. Please try again in a moment.';
  if (/HTTP 429/i.test(rawMsg))
    return 'Rate limit reached. Please wait a moment and try again.';
  if (/HTTP 5\d\d/i.test(rawMsg) || /network error/i.test(rawMsg) || /upstream error/i.test(rawMsg))
    return 'Data provider temporarily unavailable. Please try again shortly.';
  if (/all discovery layers failed/i.test(rawMsg))
    return 'Could not find this person online. Check the name and email.';
  if (/all enrichment layers failed/i.test(rawMsg))
    return 'Could not retrieve profile data. Please try again.';
  if (/could not determine linkedin id/i.test(rawMsg))
    return 'Found a LinkedIn profile but could not extract data. Please try again.';
  if (/credit limit/i.test(rawMsg))
    return 'Credit limit reached. Upgrade your plan or wait for monthly reset.';
  return rawMsg;
}

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
      handleSearchSingleAttendee(msg.payload.email, sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GENERATE_BRIEF') {
      handleGenerateBrief(msg.payload.email, sender.tab?.id);
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
      payload: { error: friendlyErrorMessage((err as Error).message) },
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
      payload: { error: friendlyErrorMessage((err as Error).message) },
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
      payload: { error: friendlyErrorMessage((err as Error).message) },
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

  // Search is free (no credits) — run in parallel
  const CONCURRENCY = 3;
  console.log(LOG, `Auto-search: searching ${eligible.length} attendees (concurrency=${CONCURRENCY})`);

  const searchOne = async (attendee: typeof eligible[0]): Promise<void> => {
    await handleSearchSingleAttendee(attendee.email, senderTabId);
  };

  // Simple concurrency pool
  const queue = [...eligible];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const attendee = queue.shift();
      if (attendee) await searchOne(attendee);
    }
  });

  await Promise.all(workers);

  console.log(LOG, `Auto-search complete for "${currentMeeting?.title}"`);
}

// ─── Phase A: Search Only (free, no credits) ───────────────────────────────

async function handleSearchSingleAttendee(email: string, _senderTabId?: number): Promise<void> {
  if (!currentMeeting) return;

  const idx = currentEnriched.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return;

  // Skip if already searching, searched, enriching, or done
  const s = currentEnriched[idx].status;
  if (s === 'pending' || s === 'searched' || s === 'enriching' || s === 'done') return;

  const attendee = currentMeeting.attendees[idx];
  console.log(LOG, `Search for: "${attendee.name}" <${attendee.email}>`);
  debugLog('Background', 'info', `Search started for "${attendee.name}" <${attendee.email}>`);

  // Mark as pending/searching
  currentEnriched[idx] = { ...currentEnriched[idx], status: 'pending', stage: 'searching' };
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  const orchestrator = new WaterfallOrchestrator(cache, waterfallLogBuffer);

  let searchResult: SearchResult | null = null;
  try {
    searchResult = await orchestrator.search({
      name: attendee.name,
      email: attendee.email,
      company: attendee.company || '',
    });

    // Stop at "searched" — user must click "Generate Brief" to continue
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'searched',
      stage: 'searching',
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
      error: `Search failed: ${friendlyErrorMessage(errMsg)}`,
    };
    broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

    const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting.title, 'error', null, false);
    addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));
  }
}

// ─── Phase B: Generate Brief (1 credit) ────────────────────────────────────

async function handleGenerateBrief(email: string, _senderTabId?: number): Promise<void> {
  if (!currentMeeting) return;

  const idx = currentEnriched.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return;

  const ea = currentEnriched[idx];
  // Only allow from searched state with a LinkedIn URL
  if (ea.status !== 'searched' || !ea.searchResult?.linkedinUrl) return;

  const attendee = currentMeeting.attendees[idx];
  const linkedInUrl = ea.searchResult.linkedinUrl;
  console.log(LOG, `Generate brief for: "${attendee.name}" <${attendee.email}>`);
  debugLog('Background', 'info', `Brief generation started for "${attendee.name}" <${attendee.email}>`);

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

  currentEnriched[idx] = { ...currentEnriched[idx], status: 'enriching', stage: 'fetching' };
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
      linkedInUrl,
    });
  } catch (enrichErr) {
    const errMsg = (enrichErr as Error).message;
    console.error(LOG, `Enrich failed for ${email}:`, errMsg);
    debugLog('Background', 'error', `Enrich failed for ${email}: ${errMsg}`);
    currentEnriched[idx] = {
      ...currentEnriched[idx],
      status: 'error',
      stage: 'complete',
      error: `Enrichment failed: ${friendlyErrorMessage(errMsg)}`,
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
  const logEa = currentEnriched[idx];
  const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting.title, logEa.status === 'error' ? 'error' : 'done', logEa.personData ?? null, logEa.fromCache ?? false);
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

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-company`;
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

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'CONTACT_INFO_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-contact`;
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

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'CUSTOM_ENRICHMENT_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-custom`;
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
