// PreMeet background service worker
// Handles message routing between content script, popup, and side panel.
// Supports both the basic enrichment pipeline (MEETING_DETECTED) and the
// full waterfall enrichment pipeline (FETCH_PERSON_BACKGROUND).

import type { MeetingEvent, EnrichedAttendee, ContentToBackground, PopupToBackground } from '../types';
import { enrichAll } from './enrichment';
import { hasCredit, useCredit } from '../utils/credits';
import { WaterfallOrchestrator, CacheManager } from './enrichment/index';
import type { PersonData, ProgressPayload } from './enrichment/types';

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

// ─── API Token Resolution ────────────────────────────────────────────────────

async function resolveApiToken(): Promise<string | null> {
  try {
    const result = await chrome.storage.sync.get('premeet_api_token');
    return result.premeet_api_token || null;
  } catch {
    return null;
  }
}

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

    return false;
  },
);

// ─── Waterfall Enrichment Pipeline ───────────────────────────────────────────

async function handleFetchPersonBackground(
  payload: { name: string; email: string; company: string },
  senderTabId?: number,
): Promise<void> {
  console.log(LOG, `Waterfall fetch for: "${payload.name}" <${payload.email}>`);

  const apiToken = await resolveApiToken();
  if (!apiToken) {
    broadcastToPopups({
      type: 'PERSON_BACKGROUND_RESULT',
      payload: { error: 'No API token configured. Set your token in extension settings.' },
    });
    return;
  }

  const orchestrator = new WaterfallOrchestrator(cache, apiToken);

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
  currentEnriched = meeting.attendees.map((a) => ({
    ...a,
    person: null,
    enrichedAt: Date.now(),
    status: 'pending' as const,
  }));

  broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: currentEnriched } });

  if (senderTabId != null) {
    chrome.sidePanel.open({ tabId: senderTabId }).catch((err) => {
      console.warn(LOG, 'Could not auto-open side panel:', err);
    });
  }

  try {
    const creditAvailable = await hasCredit();
    if (!creditAvailable) {
      console.warn(LOG, 'No enrichment credits remaining this month.');
      currentEnriched = meeting.attendees.map((a) => ({
        ...a,
        person: null,
        enrichedAt: Date.now(),
        status: 'error' as const,
        error: 'Monthly enrichment limit reached. Upgrade to Pro for unlimited enrichments.',
      }));
      broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: currentEnriched } });
      return;
    }

    const enriched = await enrichAll(meeting.attendees);
    currentEnriched = enriched;

    await useCredit();

    broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: enriched } });
    notifyContentScript({ type: 'ENRICHMENT_COMPLETE' });

    console.log(LOG, `Enrichment complete for "${meeting.title}"`);
  } catch (err) {
    console.error(LOG, 'Enrichment pipeline error:', err);
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
