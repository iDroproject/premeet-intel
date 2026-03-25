// PreMeet background service worker
// Handles message routing between content script, popup, and side panel.
// Supports both the basic enrichment pipeline (MEETING_DETECTED) and the
// full waterfall enrichment pipeline (FETCH_PERSON_BACKGROUND).

import type { MeetingEvent, EnrichedAttendee, EnrichmentStage, ContentToBackground, PopupToBackground } from '../types';
import { enrichAttendee } from './enrichment';
import { hasCredit, useCredit, getCredits } from '../utils/credits';
import { WaterfallOrchestrator, CacheManager } from './enrichment/index';
import type { PersonData, ProgressPayload } from './enrichment/types';
import { addLogEntry, getActivityLog } from '../utils/activityLog';
import type { ActivityLogEntry, DataSourceLabel } from '../types';
import { signInWithGoogle, signOut, getAuthState, getCurrentUser } from '../lib/auth';

const LOG = '[PreMeet][SW]';

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

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
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

  const orchestrator = new WaterfallOrchestrator(cache);

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

  // Check credits
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

  // Mark as pending/searching
  currentEnriched[idx] = { ...currentEnriched[idx], status: 'pending', stage: 'searching' };
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  // Resolving stage
  currentEnriched[idx] = { ...currentEnriched[idx], stage: 'resolving' };
  broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

  try {
    // Enriching stage
    currentEnriched[idx] = { ...currentEnriched[idx], stage: 'enriching' };
    broadcastToPopups({ type: 'ATTENDEE_UPDATE', payload: { email, attendee: currentEnriched[idx] } });

    let personData: PersonData | null = null;

    try {
      const orchestrator = new WaterfallOrchestrator(cache);
      orchestrator.onInterimResult = (interim: PersonData) => {
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
      personData = await orchestrator.fetch({
        name: attendee.name,
        email: attendee.email,
        company: attendee.company || '',
      });
    } catch (waterfallErr) {
      const errMsg = (waterfallErr as Error).message;
      console.error(LOG, `Waterfall failed for ${email}:`, errMsg);

      // Mark as error with descriptive message instead of silently falling back
      currentEnriched[idx] = {
        ...currentEnriched[idx],
        status: 'error',
        stage: 'complete',
        error: errMsg.includes('VITE_SUPABASE_URL')
          ? 'Enrichment backend not configured. Check extension settings.'
          : errMsg.includes('Not authenticated')
            ? 'Please sign in to use enrichment.'
            : `Enrichment failed: ${errMsg}`,
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
  } catch (err) {
    console.error(LOG, `Enrichment failed for ${email}:`, err);
    currentEnriched[idx] = { ...currentEnriched[idx], status: 'error', stage: 'complete', error: (err as Error).message };
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
    console.log(LOG, `All attendees enriched for "${currentMeeting.title}"`);
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
