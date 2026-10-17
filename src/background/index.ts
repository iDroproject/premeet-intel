// PreMeet background service worker
// Handles message routing between content script, popup, and side panel.
// Supports both the basic enrichment pipeline (MEETING_DETECTED) and the
// full waterfall enrichment pipeline (FETCH_PERSON_BACKGROUND).

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, ContentToBackground, PopupToBackground } from '../types';
import { hasCredit, useCredit, getCredits } from '../utils/credits';
import { WaterfallOrchestrator, CacheManager, normaliseCacheKey, EnrichmentCacheService } from './waterfall-data-fetch/index';
import type { PersonData, ProgressPayload, SearchResult, CompanyData, ContactInfo, HiringSignals, StakeholderMap, SocialPulse, ReputationData } from './waterfall-data-fetch/types';
import { addLogEntry, getActivityLog } from '../utils/activityLog';
import type { ActivityLogEntry, DataSourceLabel } from '../types';
import { signInWithGoogle, signOut, getAuthState, getCurrentUser, authFetch } from '../lib/auth';
import { getSettings, cacheDurationMs } from '../utils/settings';
import { createLogBuffer, log as debugLog } from '../utils/logger';
import { hasSearchQuota, useSearchQuota, getSearchQuota } from '../utils/rateLimit';

const LOG = '[PreMeet][SW]';
const waterfallLogBuffer = createLogBuffer('Enrichment');

/** Maps raw pipeline errors to user-friendly messages. */
function friendlyErrorMessage(rawMsg: string): string {
  if (rawMsg.includes('VITE_API_BASE_URL'))
    return 'API base URL not configured. Set VITE_API_BASE_URL in .env';
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
  if (/all enrichment layers failed/i.test(rawMsg)) {
    if (/timed out/i.test(rawMsg)) return 'Profile data took too long to load. Please try again.';
    if (/HTTP 429/i.test(rawMsg)) return 'Rate limit reached on data provider. Please wait and try again.';
    return 'Could not retrieve profile data. Please try again.';
  }
  if (/could not determine linkedin id/i.test(rawMsg))
    return 'Found a LinkedIn profile but could not extract data. Please try again.';
  if (/credit limit/i.test(rawMsg))
    return 'Credit limit reached. Upgrade your plan or wait for monthly reset.';
  return 'An unexpected error occurred. Please try again.';
}

// ─── Module-level Singletons ─────────────────────────────────────────────────

const cache = new CacheManager();

/**
 * Build a WaterfallOrchestrator configured with the user's cache-duration
 * setting, so 'never' truly disables caching and 1d/7d/30d are honored (the
 * setting was previously ignored).
 */
async function makeOrchestrator(): Promise<WaterfallOrchestrator> {
  let ttlMs: number | undefined;
  try {
    ttlMs = cacheDurationMs((await getSettings()).cacheDuration);
  } catch {
    ttlMs = undefined; // fall back to the orchestrator default
  }
  return new WaterfallOrchestrator(cache, waterfallLogBuffer, ttlMs);
}

// ─── In-Memory State ─────────────────────────────────────────────────────────
// MV3 service workers are terminated when idle and restarted on demand, which
// wipes module-level state. We mirror the active meeting to chrome.storage.session
// (survives SW restarts, cleared when the browser closes) and rehydrate lazily.

let currentMeeting: MeetingEvent | null = null;
let currentEnriched: EnrichedAttendee[] = [];

// Monotonic generation token — bumped on every MEETING_DETECTED. Long-running
// search/enrich handlers capture the value at start and abort their writes if a
// newer meeting has since replaced the state, so results never land in the wrong
// meeting's attendee slot.
let meetingGeneration = 0;

const SESSION_KEYS = {
  meeting: 'pm_active_meeting',
  enriched: 'pm_active_enriched',
  generation: 'pm_active_generation',
} as const;

async function persistMeetingState(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [SESSION_KEYS.meeting]: currentMeeting,
      [SESSION_KEYS.enriched]: currentEnriched,
      [SESSION_KEYS.generation]: meetingGeneration,
    });
  } catch (err) {
    console.warn(LOG, 'Failed to persist meeting state:', (err as Error).message);
  }
}

let _rehydrated = false;
async function ensureRehydrated(): Promise<void> {
  if (_rehydrated || currentMeeting) {
    _rehydrated = true;
    return;
  }
  try {
    const stored = await chrome.storage.session.get([
      SESSION_KEYS.meeting,
      SESSION_KEYS.enriched,
      SESSION_KEYS.generation,
    ]);
    if (stored[SESSION_KEYS.meeting]) {
      currentMeeting = stored[SESSION_KEYS.meeting] as MeetingEvent;
      currentEnriched = (stored[SESSION_KEYS.enriched] as EnrichedAttendee[]) ?? [];
      meetingGeneration = (stored[SESSION_KEYS.generation] as number) ?? 0;
      console.log(LOG, 'Rehydrated meeting state from session storage');
    }
  } catch (err) {
    console.warn(LOG, 'Failed to rehydrate meeting state:', (err as Error).message);
  }
  _rehydrated = true;
}

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
      ensureRehydrated().then(() => {
        sendResponse({ ok: true, meeting: currentMeeting, attendees: currentEnriched });
      });
      return true; // async response
    }

    if (msg.type === 'OPEN_UPGRADE') {
      handleOpenUpgrade(msg.payload?.tier ?? 'pro')
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: (err as Error).message }));
      return true; // async response
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

    if (msg.type === 'FETCH_HIRING_SIGNALS') {
      handleFetchHiringSignals(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_STAKEHOLDER_MAP') {
      handleFetchStakeholderMap(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_SOCIAL_PULSE') {
      handleFetchSocialPulse(msg.payload);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'FETCH_REPUTATION') {
      handleFetchReputation(msg.payload);
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

    if (msg.type === 'GET_SEARCH_QUOTA') {
      getSearchQuota().then((quota) => sendResponse({ ok: true, ...quota })).catch(() => sendResponse({ ok: false }));
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 200;

async function handleFetchPersonBackground(
  payload: { name: string; email: string; company: string },
  senderTabId?: number,
): Promise<void> {
  // Validate required fields before processing
  if (!payload || typeof payload !== 'object') {
    console.warn(LOG, 'handleFetchPersonBackground: invalid payload type');
    return;
  }
  if (typeof payload.email !== 'string' || !EMAIL_RE.test(payload.email.trim())) {
    console.warn(LOG, `handleFetchPersonBackground: invalid email "${payload.email}"`);
    broadcastToPopups({ type: 'PERSON_BACKGROUND_RESULT', payload: { error: 'Invalid email address in request.' } });
    return;
  }
  if (typeof payload.name === 'string' && payload.name.length > MAX_FIELD_LENGTH) {
    console.warn(LOG, `handleFetchPersonBackground: name too long (${payload.name.length} chars), truncating`);
    payload = { ...payload, name: payload.name.slice(0, MAX_FIELD_LENGTH) };
  }
  if (typeof payload.company === 'string' && payload.company.length > MAX_FIELD_LENGTH) {
    console.warn(LOG, `handleFetchPersonBackground: company too long (${payload.company.length} chars), truncating`);
    payload = { ...payload, company: payload.company.slice(0, MAX_FIELD_LENGTH) };
  }

  console.log(LOG, `Waterfall fetch for: "${payload.name}" <${payload.email}>`);
  debugLog('Background', 'info', `Waterfall fetch started for "${payload.name}" <${payload.email}>`);

  const orchestrator = await makeOrchestrator();

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

  const orchestrator = await makeOrchestrator();

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

  const orchestrator = await makeOrchestrator();

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
  meetingGeneration++; // invalidate any in-flight work from the previous meeting
  const generation = meetingGeneration;
  // Show attendees immediately as idle — no enrichment until user clicks a card
  currentEnriched = meeting.attendees.map((a) => ({
    ...a,
    person: null,
    enrichedAt: Date.now(),
    status: 'idle' as const,
  }));
  _rehydrated = true;
  await persistMeetingState();

  broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meetingGen: generation, meeting, attendees: currentEnriched } });

  if (senderTabId != null) {
    chrome.sidePanel.open({ tabId: senderTabId }).catch((err) => {
      console.warn(LOG, 'Could not auto-open side panel:', err);
    });
  }

  // Pre-warm: eagerly check cache for all attendees before auto-search
  await preWarmAttendeeCache(meeting);

  // Auto-search all attendees if setting is enabled
  try {
    const settings = await getSettings();
    if (settings.autoSearchAttendees) {
      autoSearchAllAttendees(senderTabId).catch((err) => {
        console.error(LOG, 'autoSearchAllAttendees error:', (err as Error).message);
      });
    }
  } catch (err) {
    console.warn(LOG, 'Failed to check autoSearchAttendees setting:', err);
  }
}

/**
 * Pre-warm: check local + server cache for all attendees in parallel.
 * If cached data exists, immediately mark the attendee as "searched" (or "done"
 * if full PersonData is available), so auto-search skips them entirely.
 * This avoids redundant SERP/deep-lookup calls for repeat attendees.
 */
async function preWarmAttendeeCache(meeting: MeetingEvent): Promise<void> {
  // Capture the generation of the meeting we're warming. If a newer meeting
  // replaces the state during the async cache reads below, our writes must not
  // splice stale cached data into the new meeting's slots.
  const gen = meetingGeneration;
  const auth = await getAuthState();
  const serverCache = auth.isAuthenticated ? new EnrichmentCacheService() : null;
  let warmed = 0;

  const checks = meeting.attendees.map(async (attendee, _idx) => {
    const cacheKey = `person_${normaliseCacheKey(attendee.email || attendee.name || 'unknown')}`;

    // Check local Chrome cache first
    let personData = await cache.get<PersonData>(cacheKey);

    // Fall back to server cache
    if (!personData && serverCache) {
      try {
        const serverResult = await serverCache.get('person', cacheKey);
        if (serverResult.hit && serverResult.data) {
          personData = serverResult.data as unknown as PersonData;
          // Backfill local cache
          await cache.set(cacheKey, personData).catch(() => {});
        }
      } catch {
        // Non-fatal
      }
    }

    if (!personData) return;

    // Re-resolve the slot against the CURRENT meeting; skip if it was superseded.
    const slot = liveSlot(attendee.email, gen);
    if (slot === null) return;

    warmed++;
    // Mark as searched with cached search result so auto-search skips this attendee
    currentEnriched[slot] = {
      ...currentEnriched[slot],
      status: 'searched',
      stage: 'searching',
      searchResult: {
        name: personData.name,
        firstName: personData.firstName,
        lastName: personData.lastName,
        avatarUrl: personData.avatarUrl,
        currentTitle: personData.currentTitle,
        currentCompany: personData.currentCompany,
        location: personData.location,
        connections: personData.connections,
        followers: personData.followers,
        linkedinUrl: personData.linkedinUrl,
        confidence: personData._confidence,
        confidenceScore: personData._confidenceScore,
      },
      hasLinkedIn: !!personData.linkedinUrl,
      personData,
    };

    emitAttendeeUpdate(attendee.email, currentEnriched[slot]);
  });

  await Promise.all(checks);

  if (warmed > 0) {
    console.log(LOG, `Pre-warmed ${warmed}/${meeting.attendees.length} attendees from cache`);
  }
}

/**
 * Auto-enrich all attendees sequentially, skipping the current user.
 * Stops early if credits run out.
 */
async function autoSearchAllAttendees(senderTabId?: number): Promise<void> {
  if (!currentMeeting) return;

  // Guard: skip entirely if not authenticated — no point firing waterfall calls that will all fail
  const authState = await getAuthState();
  if (!authState.isAuthenticated) {
    console.log(LOG, 'Auto-search skipped: user is not signed in');
    return;
  }

  // Get current user email to exclude from auto-search
  let currentUserEmail: string | null = null;
  try {
    currentUserEmail = authState.user?.email?.toLowerCase() ?? null;
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
  await ensureRehydrated();
  if (!currentMeeting) return;

  const gen = meetingGeneration;
  const idx = currentEnriched.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  if (idx === -1) return;

  // Skip if already searching, searched, enriching, or done
  const s = currentEnriched[idx].status;
  if (s === 'pending' || s === 'searched' || s === 'enriching' || s === 'done') return;

  // Guard: require authentication before making any API calls. Re-resolve the
  // slot after the await — a new meeting may have replaced currentEnriched.
  const authState = await getAuthState();
  {
    const slot = liveSlot(email, gen);
    if (slot === null) return;
    if (!authState.isAuthenticated) {
      console.log(LOG, `Search skipped for ${email}: user is not signed in`);
      currentEnriched[slot] = {
        ...currentEnriched[slot],
        status: 'error',
        stage: 'complete',
        error: 'Sign in to view meeting briefs',
      };
      emitAttendeeUpdate(email, currentEnriched[slot]);
      return;
    }
  }

  const attendee = currentMeeting.attendees[idx];

  // Phase 1: client-side daily rate limit
  if (!(await hasSearchQuota())) {
    const quota = await getSearchQuota();
    const slot = liveSlot(email, gen);
    if (slot === null) return;
    console.warn(LOG, `Daily search limit reached (${quota.used}/${quota.limit})`);
    currentEnriched[slot] = {
      ...currentEnriched[slot],
      status: 'error',
      stage: 'complete',
      error: `Daily search limit reached (${quota.limit}/day). Resets tomorrow.`,
    };
    emitAttendeeUpdate(email, currentEnriched[slot]);
    return;
  }

  console.log(LOG, `Search for: "${attendee.name}" <${attendee.email}>`);
  debugLog('Background', 'info', `Search started for "${attendee.name}" <${attendee.email}>`);

  // Mark as pending/searching (re-resolve after the quota check above).
  {
    const slot = liveSlot(email, gen);
    if (slot === null) return;
    currentEnriched[slot] = { ...currentEnriched[slot], status: 'pending', stage: 'searching' };
    emitAttendeeUpdate(email, currentEnriched[slot]);
  }

  // Count this search against the daily quota
  await useSearchQuota().catch(() => {});

  const orchestrator = await makeOrchestrator();

  let searchResult: SearchResult | null = null;
  try {
    searchResult = await orchestrator.search({
      name: attendee.name,
      email: attendee.email,
      company: attendee.company || '',
    });

    // The meeting may have changed while we were searching — abandon a stale write.
    const slot = liveSlot(email, gen);
    if (slot === null) return;

    // Stop at "searched" — user must click "Generate Brief" to continue
    currentEnriched[slot] = {
      ...currentEnriched[slot],
      status: 'searched',
      stage: 'searching',
      searchResult,
      hasLinkedIn: !!searchResult.linkedinUrl,
    };
    emitAttendeeUpdate(email, currentEnriched[slot]);
  } catch (searchErr) {
    const errMsg = (searchErr as Error).message;
    const errStack = (searchErr as Error).stack || '';
    console.error(LOG, `Search failed for ${email}:`, errMsg, '\nStack:', errStack);
    debugLog('Background', 'error', `Search failed for ${email}: ${errMsg}`);
    // Persist last error for diagnostics (retrievable via chrome.storage.local.get('pm_last_error'))
    chrome.storage.local.set({ pm_last_error: { email, error: errMsg, stack: errStack, ts: Date.now() } }).catch(() => {});

    const slot = liveSlot(email, gen);
    if (slot === null) return;
    currentEnriched[slot] = {
      ...currentEnriched[slot],
      status: 'error',
      stage: 'complete',
      error: `Search failed: ${friendlyErrorMessage(errMsg)}`,
    };
    emitAttendeeUpdate(email, currentEnriched[slot]);

    const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting?.title ?? '', 'error', null, false);
    addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));
  }
}

// ─── Phase B: Generate Brief (1 credit) ────────────────────────────────────

async function handleGenerateBrief(email: string, _senderTabId?: number): Promise<void> {
  await ensureRehydrated();
  if (!currentMeeting) return;

  const gen = meetingGeneration;
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

  // Re-resolve the slot after the async credit check — a new meeting may have
  // replaced currentEnriched while we awaited, and this 'enriching' write must
  // not land in the new meeting's array (it would strand that attendee, since
  // auto-search skips anything already 'enriching').
  {
    const slot = liveSlot(email, gen);
    if (slot === null) return;
    currentEnriched[slot] = { ...currentEnriched[slot], status: 'enriching', stage: 'fetching' };
    emitAttendeeUpdate(email, currentEnriched[slot]);
  }

  let personData: PersonData | null = null;
  let enrichFailed = false;
  try {
    const enrichOrchestrator = await makeOrchestrator();
    enrichOrchestrator.onInterimResult = (interim: PersonData) => {
      // The meeting may have changed while enriching — never write into a
      // superseded meeting's slot.
      const s = liveSlot(email, gen);
      if (s === null) return;
      currentEnriched[s] = {
        ...currentEnriched[s],
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
      emitAttendeeUpdate(email, currentEnriched[s]);
    };
    personData = await enrichOrchestrator.enrich({
      name: attendee.name,
      email: attendee.email,
      company: attendee.company || '',
      linkedInUrl,
    });
  } catch (enrichErr) {
    enrichFailed = true;
    const errMsg = (enrichErr as Error).message;
    console.error(LOG, `Enrich failed for ${email}:`, errMsg);
    debugLog('Background', 'error', `Enrich failed for ${email}: ${errMsg}`);
    const s = liveSlot(email, gen);
    if (s !== null) {
      currentEnriched[s] = {
        ...currentEnriched[s],
        status: 'error',
        stage: 'complete',
        error: `Enrichment failed: ${friendlyErrorMessage(errMsg)}`,
      };
    }
  }

  // If the meeting changed while we were enriching, abandon the result entirely
  // (do not write, do not charge for a brief the user can no longer see).
  const slot = liveSlot(email, gen);
  if (slot === null) return;

  if (personData) {
    currentEnriched[slot] = {
      ...currentEnriched[slot],
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

  emitAttendeeUpdate(email, currentEnriched[slot]);

  // Log the outcome.
  const logEa = currentEnriched[slot];
  const logEntry = buildLogEntry(attendee.name, attendee.email, currentMeeting?.title ?? '', logEa.status === 'error' ? 'error' : 'done', logEa.personData ?? null, logEa.fromCache ?? false);
  addLogEntry(logEntry).catch((e) => console.warn(LOG, 'Failed to write activity log:', e));

  // Consume a credit ONLY on a successful fresh brief — never charge for a failed
  // enrichment, and never for a cache hit.
  if (personData && !enrichFailed && !logEa.fromCache) {
    await useCredit().catch((e) => console.warn(LOG, 'Failed to use credit:', e));
  }

  // Check if all attendees are now enriched
  const allDone = currentEnriched.every((a) => a.status === 'done' || a.status === 'error');
  if (allDone) {
    notifyContentScript({ type: 'ENRICHMENT_COMPLETE' });
    debugLog('Background', 'info', `All attendees enriched for "${currentMeeting?.title ?? ''}"`);
    console.log(LOG, `All attendees enriched for "${currentMeeting?.title ?? ''}"`);
  }
}

// ─── Company Intel (on-demand, 1 credit) ─────────────────────────────────────

// MCP enrichment feature flag — when enabled, fetches richer data from
// Crunchbase + ZoomInfo via the enrichment-mcp endpoint instead of
// the single-source enrichment-company endpoint.
// MCP enrichment disabled — using hybrid fast SERP + deep (Dataset Filter + Google AI Mode) instead.

async function handleFetchCompanyIntel(
  payload: { email: string; companyName: string; linkedinUrl?: string; website?: string },
): Promise<void> {
  const { email, companyName, linkedinUrl, website } = payload;
  console.log(LOG, 'Company intel fetch (hybrid: fast SERP + deep)');

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  // Phase 1: Fast SERP basic profile (~3s)
  const fastBody: Record<string, string> = { companyName };
  if (linkedinUrl) fastBody.linkedinUrl = linkedinUrl;
  if (website) fastBody.website = website;

  let basicData: CompanyData | null = null;
  // Track whether we broadcast ANY terminal result, so the sidepanel's loading
  // skeleton always resolves — even when every phase fails.
  let sent = false;

  try {
    const fastRes = await authFetch(`${apiBase}/enrichment-company`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fastBody),
    });

    if (fastRes.ok) {
      const fastJson = await fastRes.json() as { data: CompanyData; cached: boolean };
      basicData = fastJson.data;
      console.log(LOG, `Company fast profile for "${companyName}" (cached: ${fastJson.cached})`);
      // Broadcast basic result immediately so UI renders fast
      broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, data: basicData, cached: fastJson.cached } });
      sent = true;
    } else {
      const errBody = await fastRes.json().catch(() => ({ error: `HTTP ${fastRes.status}` }));
      console.warn(LOG, 'Company fast profile failed:', (errBody as { error?: string }).error);
    }
  } catch (err) {
    console.warn(LOG, 'Company fast profile error:', (err as Error).message);
  }

  // Phase 2: Deep enrichment (Dataset Filter 331pts + Google AI Mode) — runs in background
  const discoveredLinkedinId = basicData?.linkedinId
    || (linkedinUrl?.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i)?.[1] ?? null);

  if (!discoveredLinkedinId) {
    console.log(LOG, `No LinkedIn company ID for "${companyName}" — skipping deep enrichment`);
    if (!sent) {
      broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: 'No company data found' } });
    }
    return;
  }

  try {
    const deepBody: Record<string, string> = {
      companyName,
      linkedinId: discoveredLinkedinId,
    };
    if (linkedinUrl) deepBody.linkedinUrl = linkedinUrl;
    if (website) deepBody.website = website;

    const deepRes = await authFetch(`${apiBase}/enrichment-company-deep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deepBody),
    });

    if (deepRes.ok) {
      const deepJson = await deepRes.json() as { data: CompanyData; cached: boolean; sourceLog?: unknown[] };
      console.log(LOG, `Company deep enrichment for "${companyName}" complete`, deepJson.sourceLog);

      // Merge: deep data overwrites basic data for non-null fields
      const mergedData: CompanyData = { ...(basicData || {} as CompanyData) };
      const deep = deepJson.data;
      if (deep.name) mergedData.name = deep.name;
      if (deep.linkedinUrl) mergedData.linkedinUrl = deep.linkedinUrl;
      if (deep.linkedinId) mergedData.linkedinId = deep.linkedinId;
      if (deep.logo) mergedData.logo = deep.logo;
      if (deep.industry) mergedData.industry = deep.industry;
      if (deep.sizeRange) mergedData.sizeRange = deep.sizeRange;
      if (deep.revenueRange) mergedData.revenueRange = deep.revenueRange;
      if (deep.website) mergedData.website = deep.website;
      if (deep.foundedYear) mergedData.foundedYear = deep.foundedYear;
      if (deep.hqAddress) mergedData.hqAddress = deep.hqAddress;
      if (deep.description) mergedData.description = deep.description;
      if (deep.fundingTotal) mergedData.fundingTotal = deep.fundingTotal;
      if (deep.fundingLastRound) mergedData.fundingLastRound = deep.fundingLastRound;
      if (deep.fundingInvestors?.length) mergedData.fundingInvestors = deep.fundingInvestors;
      if (deep.products?.length) mergedData.products = deep.products;
      if (deep.technologies?.length) mergedData.technologies = deep.technologies;
      if (deep.recentNews?.length) mergedData.recentNews = deep.recentNews;
      if (deep.intentSignals?.length) mergedData.intentSignals = deep.intentSignals;
      // Attach AI overview if available
      if ((deep as CompanyData & { aiOverview?: string }).aiOverview) {
        (mergedData as CompanyData & { aiOverview?: string }).aiOverview = (deep as CompanyData & { aiOverview?: string }).aiOverview;
      }

      // Broadcast the enriched update — UI should merge/replace
      broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, data: mergedData, cached: deepJson.cached, deep: true } });
      sent = true;
    } else {
      const errBody = await deepRes.json().catch(() => ({ error: `HTTP ${deepRes.status}` }));
      console.warn(LOG, 'Company deep enrichment failed:', (errBody as { error?: string }).error);
      // Not fatal if basic data was already broadcast.
    }
  } catch (err) {
    console.warn(LOG, 'Company deep enrichment error:', (err as Error).message);
    // Not fatal if basic data was already broadcast.
  }

  // Guarantee the loading skeleton resolves even if every phase failed.
  if (!sent) {
    broadcastToPopups({ type: 'COMPANY_INTEL_RESULT', payload: { email, error: 'Company details unavailable' } });
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

// ─── Hiring Signals (on-demand power-up, 0.5 credits) ──────────────────────

async function handleFetchHiringSignals(
  payload: { email: string; companyName: string; linkedinUrl?: string; website?: string },
): Promise<void> {
  const { email, companyName, linkedinUrl, website } = payload;
  console.log(LOG, `Hiring signals fetch for: "${companyName}" (attendee: ${email})`);

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'HIRING_SIGNALS_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-hiring-signals`;
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
      const errMsg = (errBody as { error?: string; message?: string }).message
        || (errBody as { error?: string }).error
        || `HTTP ${res.status}`;
      console.error(LOG, `Hiring signals error for "${companyName}":`, errMsg);
      broadcastToPopups({ type: 'HIRING_SIGNALS_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: HiringSignals; cached: boolean };
    console.log(LOG, `Hiring signals complete for "${companyName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'HIRING_SIGNALS_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Hiring signals fetch failed for "${companyName}":`, errMsg);
    broadcastToPopups({ type: 'HIRING_SIGNALS_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Stakeholder Map (on-demand power-up, 1 credit) ─────────────────────────

async function handleFetchStakeholderMap(
  payload: { email: string; companyName: string; linkedinUrl?: string },
): Promise<void> {
  const { email, companyName, linkedinUrl } = payload;
  console.log(LOG, `Stakeholder map fetch for: "${companyName}" (attendee: ${email})`);

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'STAKEHOLDER_MAP_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-stakeholder-map`;
  const body: Record<string, string> = { companyName };
  if (linkedinUrl) body.linkedinUrl = linkedinUrl;

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
      console.error(LOG, `Stakeholder map error for "${companyName}":`, errMsg);
      broadcastToPopups({ type: 'STAKEHOLDER_MAP_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: StakeholderMap; cached: boolean };
    console.log(LOG, `Stakeholder map complete for "${companyName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'STAKEHOLDER_MAP_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Stakeholder map fetch failed for "${companyName}":`, errMsg);
    broadcastToPopups({ type: 'STAKEHOLDER_MAP_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Social Pulse (on-demand power-up, 0.5 credits) ─────────────────────────

async function handleFetchSocialPulse(
  payload: { email: string; companyName: string; website?: string },
): Promise<void> {
  const { email, companyName, website } = payload;
  console.log(LOG, `Social pulse fetch for: "${companyName}" (attendee: ${email})`);

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'SOCIAL_PULSE_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-social-pulse`;
  const body: Record<string, string> = { companyName };
  if (website) body.website = website;

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
      console.error(LOG, `Social pulse error for "${companyName}":`, errMsg);
      broadcastToPopups({ type: 'SOCIAL_PULSE_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: SocialPulse; cached: boolean };
    console.log(LOG, `Social pulse complete for "${companyName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'SOCIAL_PULSE_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Social pulse fetch failed for "${companyName}":`, errMsg);
    broadcastToPopups({ type: 'SOCIAL_PULSE_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Reputation (on-demand power-up, 0.5 credits) ���─────────────────────────

async function handleFetchReputation(
  payload: { email: string; companyName: string },
): Promise<void> {
  const { email, companyName } = payload;
  console.log(LOG, `Reputation fetch for: "${companyName}" (attendee: ${email})`);

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  if (!apiBase) {
    broadcastToPopups({ type: 'REPUTATION_RESULT', payload: { email, error: 'API not configured' } });
    return;
  }

  const url = `${apiBase}/enrichment-reputation`;
  const body: Record<string, string> = { companyName };

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
      console.error(LOG, `Reputation error for "${companyName}":`, errMsg);
      broadcastToPopups({ type: 'REPUTATION_RESULT', payload: { email, error: errMsg } });
      return;
    }

    const json = await res.json() as { data: ReputationData; cached: boolean };
    console.log(LOG, `Reputation complete for "${companyName}" (cached: ${json.cached})`);
    broadcastToPopups({ type: 'REPUTATION_RESULT', payload: { email, data: json.data, cached: json.cached } });
  } catch (err) {
    const errMsg = (err as Error).message;
    console.error(LOG, `Reputation fetch failed for "${companyName}":`, errMsg);
    broadcastToPopups({ type: 'REPUTATION_RESULT', payload: { email, error: errMsg } });
  }
}

// ─── Upgrade / Paywall ───────────────────────────────────────────────────────

const PRICING_PAGE_URL = 'https://premeet-mu.vercel.app/pricing';

/**
 * Open the paywall. For signed-in users we create a real Stripe Checkout session
 * via billing-checkout and open it; otherwise (or on any failure) we fall back to
 * the pricing page so the CTA is never a dead click.
 */
async function handleOpenUpgrade(tier: 'pro' | 'enterprise'): Promise<void> {
  const apiBase = import.meta.env.VITE_API_BASE_URL as string;
  const authState = await getAuthState().catch(() => ({ isAuthenticated: false }));

  const openTab = (url: string) => {
    chrome.tabs.create({ url }).catch((err) => console.warn(LOG, 'Failed to open upgrade tab:', err));
  };

  if (!apiBase || !authState.isAuthenticated) {
    openTab(PRICING_PAGE_URL);
    return;
  }

  try {
    const res = await authFetch(`${apiBase}/billing-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tier,
        successUrl: `${PRICING_PAGE_URL}?checkout=success`,
        cancelUrl: `${PRICING_PAGE_URL}?checkout=cancel`,
      }),
    });
    if (res.ok) {
      const { url } = (await res.json()) as { url?: string };
      openTab(url || PRICING_PAGE_URL);
    } else {
      console.warn(LOG, `billing-checkout HTTP ${res.status} — falling back to pricing page`);
      openTab(PRICING_PAGE_URL);
    }
  } catch (err) {
    console.warn(LOG, 'billing-checkout failed — falling back to pricing page:', (err as Error).message);
    openTab(PRICING_PAGE_URL);
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

/**
 * Broadcast a single attendee's updated state, stamped with the current meeting
 * generation so the sidepanel can drop updates that belong to a superseded
 * meeting, and mirror the state to session storage for SW-restart survival.
 */
function emitAttendeeUpdate(email: string, attendee: EnrichedAttendee): void {
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { meetingGen: meetingGeneration, email, attendee } });
  void persistMeetingState();
}

/**
 * Re-resolve an attendee's slot after an await. Returns null if the meeting has
 * been replaced since the caller started (generation changed) or the attendee is
 * no longer present — callers must then abandon their write so results never
 * land in the wrong meeting's slot.
 */
function liveSlot(email: string, gen: number): number | null {
  if (gen !== meetingGeneration) return null;
  const i = currentEnriched.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  return i === -1 ? null : i;
}
