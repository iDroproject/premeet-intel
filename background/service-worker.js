/**
 * background/service-worker.js
 *
 * Meeting Intel – Background Service Worker
 *
 * Responsibilities:
 *   - Configure chrome.sidePanel behaviour on install.
 *   - Handle FETCH_PERSON_BACKGROUND: delegate to WaterfallOrchestrator,
 *     stream FETCH_PROGRESS updates to the side panel while each layer runs.
 *   - Handle OPEN_SIDE_PANEL: open the side panel for the sender tab.
 *   - Handle SET_API_TOKEN: persist the Bright Data API token to chrome.storage.sync.
 *   - Handle GET_CACHE_STATS: return cache stats to the popup.
 *   - Handle PING: liveness check.
 *   - Scaffold chrome.alarms for pre-fetching upcoming calendar meetings (Phase 5).
 *
 * Architecture notes:
 *   - This file uses ES module syntax (`type: module` in manifest.json).
 *   - All external HTTP calls are made here so host_permissions bypass CORS.
 *   - The API token is loaded from chrome.storage.sync; a hardcoded fallback
 *     is used only when the stored token is absent.
 *   - The WaterfallOrchestrator is created fresh per fetch call so it always
 *     uses the most recently resolved API token.
 */

'use strict';

import { WaterfallOrchestrator } from './api/waterfall-orchestrator.js';

import { CacheManager } from './cache/cache-manager.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = '[Meeting Intel][SW]';

/** Bright Data API token (internal). */
const API_TOKEN = '30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9';

/** Bright Data SERP API zone name. */
const SERP_ZONE = 'serp';

/**
 * Alarm name for the periodic upcoming-meeting pre-fetch.
 * Fires every 2 hours to warm the cache ahead of scheduled meetings.
 * The actual Calendar API lookup is implemented in Phase 5.
 *
 * @type {string}
 */
const ALARM_PREFETCH_MEETINGS = 'prefetch-upcoming-meetings';

/**
 * Alarm name for the periodic cache-eviction sweep.
 *
 * @type {string}
 */
const ALARM_REFRESH_CACHE = 'refresh-cache';

/**
 * Enumeration of all message type strings used across the extension.
 * Centralised here to prevent typo-driven bugs across components.
 */
const MessageType = /** @type {const} */ ({
  FETCH_PERSON_BACKGROUND:  'FETCH_PERSON_BACKGROUND',
  FETCH_PROGRESS:           'FETCH_PROGRESS',
  OPEN_SIDE_PANEL:          'OPEN_SIDE_PANEL',
  PERSON_BACKGROUND_RESULT: 'PERSON_BACKGROUND_RESULT',
  GET_CACHE_STATS:          'GET_CACHE_STATS',
  CLEAR_CACHE:              'CLEAR_CACHE',
  PING:                     'PING',
});

// ─── Module-level singletons ─────────────────────────────────────────────────

/** Shared CacheManager instance for this service worker lifecycle. */
const cache = new CacheManager();

// ─── Side Panel Setup ────────────────────────────────────────────────────────

/**
 * Configure side panel behaviour and register alarms on extension install
 * or update.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(LOG_PREFIX, 'Extension installed/updated:', details.reason);

  // Configure the side panel to open only on explicit programmatic open() calls
  // (not automatically when the toolbar icon is clicked).
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    console.log(LOG_PREFIX, 'Side panel behaviour configured');
  } catch (err) {
    // setPanelBehavior is available from Chrome 116; log gracefully if absent.
    console.warn(LOG_PREFIX, 'Could not set panel behaviour:', err.message);
  }

  await registerAlarms();
});

// ─── Alarm Registration ───────────────────────────────────────────────────────

/**
 * Create (or replace) the recurring alarms used by the service worker.
 *
 * Called both on `onInstalled` and on each service-worker startup so the
 * alarms survive extension updates and service-worker restarts.
 *
 * @returns {Promise<void>}
 */
async function registerAlarms() {
  try {
    // Cache eviction: runs every 30 minutes.
    await chrome.alarms.create(ALARM_REFRESH_CACHE, {
      delayInMinutes:  30,
      periodInMinutes: 30,
    });

    // Upcoming-meeting pre-fetch: scaffold for Phase 5 Calendar integration.
    // The alarm fires every 2 hours; the handler below logs the event but
    // does not yet query the Calendar API.
    await chrome.alarms.create(ALARM_PREFETCH_MEETINGS, {
      delayInMinutes:  2,
      periodInMinutes: 120,
    });

    console.log(
      LOG_PREFIX,
      'Alarms registered:', ALARM_REFRESH_CACHE, '+', ALARM_PREFETCH_MEETINGS
    );
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to register alarms:', err.message);
  }
}

// ─── Core Fetch Pipeline ─────────────────────────────────────────────────────

/**
 * Fetch background information for a person using the WaterfallOrchestrator.
 *
 * The orchestrator's `onProgress` callback is wired to push `FETCH_PROGRESS`
 * messages to the side panel so the user sees which layer is currently running
 * (e.g. "Trying LinkedIn scrape…", "Trying deep lookup…").
 *
 * A fresh WaterfallOrchestrator is created per call so it always uses the
 * most recently resolved API token.
 *
 * @param {{ name: string, email: string, company: string|null }} payload
 * @returns {Promise<import('./api/response-normalizer.js').PersonData>}
 * @throws {Error} When no data could be retrieved from any source.
 */
async function fetchPersonBackground(payload) {
  const orchestrator = new WaterfallOrchestrator(cache, API_TOKEN);

  // Wire progress updates to the side panel.
  orchestrator.onProgress = async (label) => {
    console.log(LOG_PREFIX, 'Waterfall progress:', label);
    await notifySidePanel({
      type:    MessageType.FETCH_PROGRESS,
      payload: { label },
    });
  };

  return orchestrator.fetch(payload);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Attempt to send a message to the side panel.
 * The side panel may not be open; connection errors are silently ignored.
 *
 * @param {object} message
 * @returns {Promise<void>}
 */
async function notifySidePanel(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (err) {
    if (!err.message?.includes('Could not establish connection')) {
      console.warn(LOG_PREFIX, 'Failed to notify side panel:', err.message);
    }
  }
}

/**
 * Open the side panel for a specific tab.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function openSidePanel(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
    console.log(LOG_PREFIX, 'Side panel opened for tab', tabId);
    return true;
  } catch (err) {
    console.error(LOG_PREFIX, 'Failed to open side panel:', err.message);
    return false;
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

/**
 * Central message router for content-script → service-worker communication.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Basic validation.
  if (!message || typeof message.type !== 'string') {
    console.warn(LOG_PREFIX, 'Received malformed message:', message);
    return false;
  }

  console.log(LOG_PREFIX, 'Received message:', message.type, 'from tab:', sender.tab?.id);

  switch (message.type) {

    // ── FETCH_PERSON_BACKGROUND ───────────────────────────────────────────────
    case MessageType.FETCH_PERSON_BACKGROUND: {
      const payload = message.payload;

      if (!payload || (!payload.email && !payload.name)) {
        console.warn(LOG_PREFIX, 'FETCH_PERSON_BACKGROUND missing payload');
        sendResponse({ ok: false, error: 'Missing payload' });
        return false;
      }

      console.log(
        LOG_PREFIX,
        `Fetching background for: ${payload.name || ''} <${payload.email || ''}>`
      );

      // Acknowledge immediately so the content script doesn't time out.
      sendResponse({ ok: true, status: 'fetching' });

      // Run the full fetch pipeline asynchronously.
      (async () => {
        // Signal the side panel to show its loading state.
        await notifySidePanel({
          type:    MessageType.FETCH_PERSON_BACKGROUND,
          payload: { name: payload.name, email: payload.email },
        });

        try {
          const personData = await fetchPersonBackground(payload);

          console.log(
            LOG_PREFIX,
            `Background ready for "${personData.name}" – source: ${personData._source},`,
            `confidence: ${personData._confidence}`
          );

          await notifySidePanel({
            type:    MessageType.PERSON_BACKGROUND_RESULT,
            payload: personData,
          });
        } catch (err) {
          console.error(LOG_PREFIX, 'fetchPersonBackground failed:', err.message);

          // Push an error result to the side panel so it can show an error state.
          await notifySidePanel({
            type:    MessageType.PERSON_BACKGROUND_RESULT,
            payload: {
              name:          payload.name || payload.email || 'Unknown',
              email:         payload.email || null,
              _error:        err.message,
              _source:       'error',
              _fetchedAt:    new Date().toISOString(),
              _confidence:   'low',
              currentTitle:  null,
              currentCompany: null,
              bio:           null,
              experience:    [],
              education:     [],
              recentPosts:   [],
            },
          });
        }
      })();

      // sendResponse was already called synchronously above.
      return false;
    }

    // ── OPEN_SIDE_PANEL ───────────────────────────────────────────────────────
    case MessageType.OPEN_SIDE_PANEL: {
      const tabId = sender.tab?.id;

      if (!tabId) {
        console.warn(LOG_PREFIX, 'OPEN_SIDE_PANEL received without a tab ID');
        sendResponse({ ok: false, error: 'No tab ID' });
        return false;
      }

      openSidePanel(tabId).then((success) => {
        sendResponse({ ok: success });
      });

      // Return true to keep the channel open for the async sendResponse.
      return true;
    }

    // ── CLEAR_CACHE ───────────────────────────────────────────────────────────
    case MessageType.CLEAR_CACHE: {
      cache.clear()
        .then(() => cache.getStats())
        .then((stats) => {
          console.log(LOG_PREFIX, 'Cache cleared by popup');
          sendResponse({ ok: true, stats });
        })
        .catch((err) => {
          console.error(LOG_PREFIX, 'CLEAR_CACHE failed:', err.message);
          sendResponse({ ok: false, error: err.message });
        });

      return true;
    }

    // ── GET_CACHE_STATS ───────────────────────────────────────────────────────
    case MessageType.GET_CACHE_STATS: {
      cache.getStats()
        .then((stats) => {
          console.log(LOG_PREFIX, 'Cache stats:', stats);
          sendResponse({ ok: true, stats });
        })
        .catch((err) => {
          console.error(LOG_PREFIX, 'getStats failed:', err.message);
          sendResponse({ ok: false, error: err.message });
        });

      return true;
    }

    // ── PING ──────────────────────────────────────────────────────────────────
    case MessageType.PING: {
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    }

    default:
      console.log(LOG_PREFIX, 'Unhandled message type:', message.type);
      return false;
  }
});

// ─── Alarm Listener ───────────────────────────────────────────────────────────

/**
 * Periodic alarm handler.
 *
 * `refresh-cache`: evicts expired cache entries by reading stats (which
 *   performs lazy deletion on observed expired keys).
 *
 * `prefetch-upcoming-meetings`: scaffold for Phase 5 Calendar API integration.
 *   When implemented, this will query Google Calendar for meetings in the next
 *   2 hours and pre-warm the cache for each attendee.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(LOG_PREFIX, 'Alarm fired:', alarm.name);

  switch (alarm.name) {

    case ALARM_REFRESH_CACHE:
      // Evict any entries that have passed their TTL by calling getStats,
      // which internally performs lazy deletion on expired keys.
      // A dedicated purgeExpired() helper can be added to CacheManager later.
      cache.getStats()
        .then((stats) => {
          console.log(
            LOG_PREFIX,
            `Cache refresh alarm: ${stats.count} valid, ` +
            `${stats.expiredCount} expired, ` +
            `~${Math.round(stats.sizeBytesEst / 1024)} KB used`
          );
        })
        .catch((err) => {
          console.warn(LOG_PREFIX, 'Cache refresh alarm error:', err.message);
        });
      break;

    case ALARM_PREFETCH_MEETINGS:
      // Phase 5 – Google Calendar API integration.
      //
      // When implemented, this block will:
      //   1. Call chrome.identity.getAuthToken() to obtain an OAuth2 token.
      //   2. Query the Calendar API for events starting in the next 2 hours.
      //   3. For each attendee not already in cache, trigger a
      //      WaterfallOrchestrator.fetch() call to warm the cache ahead of
      //      the meeting.
      //
      // For now, log a placeholder to confirm the alarm is firing.
      console.log(
        LOG_PREFIX,
        'Pre-fetch alarm fired (Phase 5 Calendar integration not yet implemented)'
      );
      break;

    default:
      console.warn(LOG_PREFIX, 'Unknown alarm:', alarm.name);
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

// Re-register alarms on each service-worker startup.  The `onInstalled`
// handler only runs on install/update, not on every SW wake-up, so alarms
// must also be created here to survive service-worker restarts.
registerAlarms().catch((err) => {
  console.error(LOG_PREFIX, 'Alarm registration on startup failed:', err.message);
});

console.log(
  LOG_PREFIX,
  'Service worker started – Meeting Intel v' + chrome.runtime.getManifest().version
);
