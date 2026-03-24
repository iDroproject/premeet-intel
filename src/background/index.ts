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

    if (msg.type === 'GET_ACTIVITY_LOG') {
      getActivityLog().then((entries) => sendResponse({ ok: true, entries })).catch(() => sendResponse({ ok: false }));
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
    stage: 'searching' as EnrichmentStage,
  }));

  // Broadcast initial state with all attendees as pending/skeleton
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
      const credits = await getCredits();
      // Compute next reset date (first of next month)
      const [y, m] = credits.resetMonth.split('-').map(Number);
      const nextReset = new Date(y, m, 1); // m is 1-indexed so this gives next month
      const resetDate = nextReset.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      currentEnriched = [];
      broadcastToPopups({ type: 'CREDITS_EXHAUSTED', payload: { meeting, resetDate } });
      return;
    }

    // Enrich attendees one by one, broadcasting per-attendee updates
    for (let i = 0; i < meeting.attendees.length; i++) {
      const attendee = meeting.attendees[i];

      // Broadcast "resolving" stage for this attendee
      currentEnriched[i] = {
        ...currentEnriched[i],
        stage: 'resolving',
      };
      broadcastToPopups({
        type: 'ATTENDEE_UPDATE',
        payload: { email: attendee.email, attendee: currentEnriched[i] },
      });

      try {
        // Broadcast "enriching" stage
        currentEnriched[i] = { ...currentEnriched[i], stage: 'enriching' };
        broadcastToPopups({
          type: 'ATTENDEE_UPDATE',
          payload: { email: attendee.email, attendee: currentEnriched[i] },
        });

        // Try waterfall pipeline first (produces rich PersonData) if API token is available
        const apiToken = await resolveApiToken();
        let personData: PersonData | null = null;

        if (apiToken) {
          try {
            const orchestrator = new WaterfallOrchestrator(cache, apiToken);
            orchestrator.onInterimResult = (interim: PersonData) => {
              // Broadcast interim data so the card progressively fills
              currentEnriched[i] = {
                ...currentEnriched[i],
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
              broadcastToPopups({
                type: 'ATTENDEE_UPDATE',
                payload: { email: attendee.email, attendee: currentEnriched[i] },
              });
            };
            personData = await orchestrator.fetch({
              name: attendee.name,
              email: attendee.email,
              company: attendee.company || '',
            });
          } catch (waterfallErr) {
            console.warn(LOG, `Waterfall failed for ${attendee.email}, falling back to basic:`, (waterfallErr as Error).message);
          }
        }

        // Fall back to basic enrichment if waterfall didn't produce data
        if (!personData) {
          const enriched = await enrichAttendee(attendee);
          const fromCache = enriched.person !== null && (Date.now() - enriched.enrichedAt) < 100;
          currentEnriched[i] = {
            ...enriched,
            stage: 'complete',
            fromCache,
            hasLinkedIn: enriched.person !== null,
          };
        } else {
          currentEnriched[i] = {
            ...currentEnriched[i],
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
        console.error(LOG, `Enrichment failed for ${attendee.email}:`, err);
        currentEnriched[i] = {
          ...currentEnriched[i],
          status: 'error',
          stage: 'complete',
          error: (err as Error).message,
        };
      }

      // Broadcast completed attendee
      broadcastToPopups({
        type: 'ATTENDEE_UPDATE',
        payload: { email: attendee.email, attendee: currentEnriched[i] },
      });

      // Log the enrichment result
      const ea = currentEnriched[i];
      const logEntry = buildLogEntry(
        attendee.name,
        attendee.email,
        meeting.title,
        ea.status === 'error' ? 'error' : 'done',
        ea.personData ?? null,
        ea.fromCache ?? false,
      );
      addLogEntry(logEntry).catch((err) => console.warn(LOG, 'Failed to write activity log:', err));
    }

    await useCredit();
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
