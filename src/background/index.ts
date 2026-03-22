// PreMeet background service worker
// Handles message routing between content script and popup.
// Runs enrichment pipeline on MEETING_DETECTED and caches the result.

import type { MeetingEvent, EnrichedAttendee, ContentToBackground, PopupToBackground } from '../types';
import { enrichAll } from './enrichment';

const LOG = '[PreMeet][SW]';

// ─── In-Memory State ──────────────────────────────────────────────────────────
// Holds the most recent meeting so the popup can retrieve it on open.

let currentMeeting: MeetingEvent | null = null;
let currentEnriched: EnrichedAttendee[] = [];

// ─── Install ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log(LOG, 'PreMeet installed.');
});

// ─── Message Handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: ContentToBackground | PopupToBackground,
    _sender,
    sendResponse
  ) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'MEETING_DETECTED') {
      handleMeetingDetected(msg.payload);
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

async function handleMeetingDetected(meeting: MeetingEvent): Promise<void> {
  console.log(LOG, `Meeting detected: "${meeting.title}" with ${meeting.attendees.length} attendee(s)`);

  currentMeeting = meeting;
  // Initialize as pending
  currentEnriched = meeting.attendees.map((a) => ({
    ...a,
    person: null,
    enrichedAt: Date.now(),
    status: 'pending' as const,
  }));

  // Broadcast pending state to any open popups
  broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: currentEnriched } });

  try {
    const enriched = await enrichAll(meeting.attendees);
    currentEnriched = enriched;

    // Broadcast final enriched data
    broadcastToPopups({ type: 'MEETING_UPDATE', payload: { meeting, attendees: enriched } });
    console.log(LOG, `Enrichment complete for "${meeting.title}"`);
  } catch (err) {
    console.error(LOG, 'Enrichment pipeline error:', err);
  }
}

function broadcastToPopups(msg: object): void {
  chrome.runtime.sendMessage(msg, () => {
    // Suppress "no receivers" errors — popup may not be open
    void chrome.runtime.lastError;
  });
}
