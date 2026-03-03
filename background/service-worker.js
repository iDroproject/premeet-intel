/**
 * background/service-worker.js
 *
 * Meeting Intel – Background Service Worker
 *
 * Responsibilities:
 *   - Configure chrome.sidePanel behaviour on install.
 *   - Handle FETCH_PERSON_BACKGROUND: cache-check → Bright Data API → normalise → push result.
 *   - Handle OPEN_SIDE_PANEL: open the side panel for the sender tab.
 *   - Handle SET_API_TOKEN: persist the Bright Data API token to chrome.storage.sync.
 *   - Handle GET_CACHE_STATS: return cache stats to the popup.
 *   - Handle PING: liveness check.
 *
 * Architecture notes:
 *   - This file uses ES module syntax (`type: module` in manifest.json).
 *   - All external HTTP calls are made here so host_permissions bypass CORS.
 *   - The API token is loaded from chrome.storage.sync; a hardcoded fallback
 *     is used only when the stored token is absent.
 */

'use strict';

import {
  scrapeByLinkedInUrl,
  searchByNameAndFetch,
  pollSnapshotUntilReady,
  downloadSnapshot,
} from './api/bright-data-scraper.js';

import { pickBestProfile } from './api/response-normalizer.js';

import { CacheManager } from './cache/cache-manager.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_PREFIX = '[Meeting Intel][SW]';

/**
 * Fallback API token used only when none has been configured via the popup.
 * In production this should be removed; tokens should always come from
 * chrome.storage.sync set by the user.
 *
 * @type {string}
 */
const FALLBACK_API_TOKEN = '30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9';

/** chrome.storage.sync key used to persist the Bright Data API token. */
const STORAGE_KEY_API_TOKEN = 'brightdata_api_token';

/** Cache TTL: 7 days in milliseconds. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MessageType = /** @type {const} */ ({
  FETCH_PERSON_BACKGROUND: 'FETCH_PERSON_BACKGROUND',
  OPEN_SIDE_PANEL:         'OPEN_SIDE_PANEL',
  PERSON_BACKGROUND_RESULT: 'PERSON_BACKGROUND_RESULT',
  SET_API_TOKEN:           'SET_API_TOKEN',
  GET_CACHE_STATS:         'GET_CACHE_STATS',
  PING:                    'PING',
});

// ─── Module-level singletons ─────────────────────────────────────────────────

/** Shared CacheManager instance for this service worker lifecycle. */
const cache = new CacheManager();

// ─── Side Panel Setup ────────────────────────────────────────────────────────

/**
 * Configure side panel behaviour on extension install or update.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(LOG_PREFIX, 'Extension installed/updated:', details.reason);

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    console.log(LOG_PREFIX, 'Side panel behaviour configured');
  } catch (err) {
    // setPanelBehavior available from Chrome 116; log gracefully if absent.
    console.warn(LOG_PREFIX, 'Could not set panel behaviour:', err.message);
  }
});

// ─── Token Resolution ────────────────────────────────────────────────────────

/**
 * Load the Bright Data API token from chrome.storage.sync.
 * Falls back to the hardcoded token if none is stored.
 *
 * @returns {Promise<string>}
 */
async function resolveApiToken() {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY_API_TOKEN);
    const stored = result[STORAGE_KEY_API_TOKEN];

    if (stored && typeof stored === 'string' && stored.trim().length > 0) {
      return stored.trim();
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Could not read API token from storage:', err.message);
  }

  console.log(LOG_PREFIX, 'Using fallback API token');
  return FALLBACK_API_TOKEN;
}

// ─── LinkedIn URL Derivation ─────────────────────────────────────────────────

/**
 * Attempt to derive a likely LinkedIn profile URL from a person's name and
 * (optionally) their email domain.
 *
 * This is a heuristic: it generates the canonical slug format LinkedIn uses
 * (hyphenated lowercase name). It will be wrong for profiles that chose a
 * custom slug, but gives the scraper a first URL to try.
 *
 * @param {string}      name   Full name, e.g. "Jane Doe".
 * @param {string|null} email  Optional email for additional hinting.
 * @returns {string|null}      Candidate URL, or null if name is unusable.
 */
function deriveLinkedInUrl(name, email) {
  if (!name || !name.trim()) return null;

  // Build a slug from the name: lowercase, replace spaces with hyphens,
  // strip characters that are invalid in LinkedIn slugs.
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  if (!slug || slug === '-') return null;

  return `https://www.linkedin.com/in/${slug}/`;
}

/**
 * Normalise a person's name into a safe cache key segment.
 * Lowercases, trims, and replaces non-alphanumeric characters with underscores.
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseCacheKey(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
}

// ─── Core Fetch Orchestrator ─────────────────────────────────────────────────

/**
 * Fetch background information for a person.
 *
 * Strategy:
 *   1. Check cache – return immediately if a fresh entry exists.
 *   2. Try scraping by a derived LinkedIn URL (fast path – synchronous API).
 *   3. If the scrape returns a pending snapshot, poll and download it.
 *   4. If the URL scrape yields no usable data, fall back to a name search.
 *   5. Normalise the raw response to PersonData.
 *   6. Cache the result.
 *   7. Return the PersonData (or throw on unrecoverable failure).
 *
 * @param {{ name: string, email: string, company: string|null }} payload
 * @returns {Promise<import('./api/response-normalizer.js').PersonData>}
 * @throws {Error} When no data could be retrieved from any source.
 */
async function fetchPersonBackground(payload) {
  const { name, email, company } = payload;
  const apiToken = await resolveApiToken();

  // ── 1. Cache check ──────────────────────────────────────────────────────────
  const cacheKey = `person_${normaliseCacheKey(name || email)}`;

  const cached = await cache.get(cacheKey);
  if (cached) {
    console.log(LOG_PREFIX, `Cache hit for "${name || email}"`);
    return cached;
  }

  console.log(LOG_PREFIX, `Cache miss – fetching from Bright Data for: "${name || email}"`);

  // ── 2. Try URL-based scrape first ───────────────────────────────────────────
  const candidateUrl = deriveLinkedInUrl(name, email);
  let rawProfiles    = null;
  let source         = 'brightdata-url';

  if (candidateUrl) {
    console.log(LOG_PREFIX, 'Trying URL-based scrape:', candidateUrl);

    try {
      const scrapeResult = await scrapeByLinkedInUrl(candidateUrl, apiToken);

      if (scrapeResult.mode === 'direct') {
        rawProfiles = scrapeResult.profiles;
        console.log(LOG_PREFIX, `Direct scrape returned ${rawProfiles.length} profile(s)`);
      } else if (scrapeResult.mode === 'snapshot') {
        // ── 3. Poll the snapshot ─────────────────────────────────────────────
        console.log(LOG_PREFIX, 'Polling snapshot from URL scrape:', scrapeResult.snapshotId);
        await pollSnapshotUntilReady(scrapeResult.snapshotId, apiToken);
        rawProfiles = await downloadSnapshot(scrapeResult.snapshotId, apiToken);
        console.log(LOG_PREFIX, `Snapshot download returned ${rawProfiles.length} profile(s)`);
      }
    } catch (urlScrapeErr) {
      console.warn(
        LOG_PREFIX,
        'URL-based scrape failed, will try name search:',
        urlScrapeErr.message
      );
      // Fall through to name search below.
    }
  }

  // ── 4. Name search fallback ─────────────────────────────────────────────────
  //
  // We fall back to name search if:
  //   a) We had no candidate URL to try.
  //   b) The URL scrape threw an error.
  //   c) The URL scrape returned an empty array (profile not found at that slug).

  const urlScrapeYieldedData = Array.isArray(rawProfiles) && rawProfiles.length > 0;

  if (!urlScrapeYieldedData && name) {
    source = 'brightdata-name';
    console.log(LOG_PREFIX, 'Falling back to name search for:', name);

    try {
      rawProfiles = await searchByNameAndFetch(name, apiToken);
      console.log(LOG_PREFIX, `Name search returned ${rawProfiles?.length ?? 0} profile(s)`);
    } catch (nameSearchErr) {
      console.error(LOG_PREFIX, 'Name search also failed:', nameSearchErr.message);
      throw new Error(
        `Could not retrieve background for "${name || email}": ` +
        nameSearchErr.message
      );
    }
  }

  // At this point if we still have no profiles, surface a clear error.
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
    throw new Error(
      `No profile data returned by Bright Data for "${name || email}"`
    );
  }

  // ── 5. Normalise ────────────────────────────────────────────────────────────
  const personData = pickBestProfile(rawProfiles, name, source);

  if (!personData) {
    throw new Error(`Could not normalise any profile for "${name || email}"`);
  }

  // Carry over the email from the calendar event if the API didn't provide one.
  // (PersonData doesn't have an email field by default; we attach it here for
  //  the side panel to display.)
  if (email && !personData.email) {
    personData.email = email;
  }

  // ── 6. Cache ────────────────────────────────────────────────────────────────
  try {
    await cache.set(cacheKey, personData, CACHE_TTL_MS);
  } catch (cacheErr) {
    // Caching failure is non-fatal; log and continue.
    console.warn(LOG_PREFIX, 'Failed to cache result:', cacheErr.message);
  }

  return personData;
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

    // ── SET_API_TOKEN ─────────────────────────────────────────────────────────
    case MessageType.SET_API_TOKEN: {
      const { token } = message.payload || {};

      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        sendResponse({ ok: false, error: 'Invalid token value' });
        return false;
      }

      chrome.storage.sync
        .set({ [STORAGE_KEY_API_TOKEN]: token.trim() })
        .then(() => {
          console.log(LOG_PREFIX, 'API token stored to chrome.storage.sync');
          sendResponse({ ok: true });
        })
        .catch((err) => {
          console.error(LOG_PREFIX, 'Failed to store API token:', err.message);
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
 * The `refresh-cache` alarm triggers a scan for and removal of expired entries.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log(LOG_PREFIX, 'Alarm fired:', alarm.name);

  switch (alarm.name) {
    case 'refresh-cache':
      // Evict any entries that have passed their TTL by calling getStats,
      // which internally observes expiry during enumeration.  A dedicated
      // purgeExpired helper can be added to CacheManager in a future phase.
      cache.getStats()
        .then((stats) => {
          console.log(
            LOG_PREFIX,
            `Cache refresh alarm: ${stats.count} valid, ${stats.expiredCount} expired`
          );
        })
        .catch((err) => {
          console.warn(LOG_PREFIX, 'Cache refresh alarm error:', err.message);
        });
      break;

    default:
      console.warn(LOG_PREFIX, 'Unknown alarm:', alarm.name);
  }
});

// ─── Startup log ─────────────────────────────────────────────────────────────

console.log(
  LOG_PREFIX,
  'Service worker started – Meeting Intel v' + chrome.runtime.getManifest().version
);
