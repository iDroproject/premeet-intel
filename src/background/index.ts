// PreMeet background service worker
// Handles message routing between content script and popup.
// Runs enrichment pipeline on MEETING_DETECTED and caches the result.

import type { MeetingEvent, EnrichedAttendee, ContentToBackground, PopupToBackground } from '../types';
import { enrichAll } from './enrichment';
import { hasCredit, useCredit } from '../utils/credits';

const LOG = '[PreMeet][SW]';

// ─── In-Memory State ──────────────────────────────────────────────────────────
// Holds the most recent meeting so the popup can retrieve it on open.

let currentMeeting: MeetingEvent | null = null;
let currentEnriched: EnrichedAttendee[] = [];

// ─── Install ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log(LOG, 'PreMeet installed.');
});

// ─── Side Panel Setup ────────────────────────────────────────────────────────
// Open the side panel automatically when the extension action is clicked.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
  console.warn(LOG, 'Failed to set side panel behavior:', err);
});

// ─── Message Handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: ContentToBackground | PopupToBackground,
    sender,
    sendResponse
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

    return false;
  }
);

// ─── Enrichment Pipeline ──────────────────────────────────────────────────────

async function handleMeetingDetected(meeting: MeetingEvent, senderTabId?: number): Promise<void> {
  console.log(LOG, `Meeting detected: "${meeting.title}" with ${meeting.attendees.length} attendee(s)`);

  currentMeeting = meeting;
  // Initialize as pending
  currentEnriched = meeting.attendees.map((a) => ({
    ...a,
    person: null,
    enrichedAt: Date.now(),
    status: 'pending' as const,
  }));

  // Broadcast pending state to any open side panels / popups
  broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: currentEnriched } });

  // Auto-open the side panel on the tab that detected the meeting
  if (senderTabId != null) {
    chrome.sidePanel.open({ tabId: senderTabId }).catch((err) => {
      console.warn(LOG, 'Could not auto-open side panel:', err);
    });
  }

  try {
    // Guard against credit exhaustion before running enrichment
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

    // Consume one credit for the enrichment run
    await useCredit();

    // Broadcast final enriched data
    broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: enriched } });

    // Notify content script that enrichment is done (used by onboarding)
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
          void chrome.runtime.lastError; // suppress if no listener
        });
      }
    }
  });
}

function broadcastToPopups(msg: object): void {
  chrome.runtime.sendMessage(msg, () => {
    // Suppress "no receivers" errors — popup may not be open
    void chrome.runtime.lastError;
  });
}
