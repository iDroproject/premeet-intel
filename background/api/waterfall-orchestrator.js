/**
 * background/api/waterfall-orchestrator.js
 *
 * Meeting Intel – Waterfall Fetch Orchestrator
 *
 * Executes a five-layer lookup cascade for a given person, stopping at the
 * first layer that returns usable profile data.  Each layer has an individual
 * timeout and full error isolation so a failure in one layer never prevents
 * the next from running.
 *
 * Waterfall layers (in execution order):
 *
 *   Layer 1 – Cache check (instant)
 *     Checks CacheManager for a non-expired entry.  A hit short-circuits
 *     the entire cascade and returns immediately.
 *
 *   Layer 2 – LinkedIn URL scrape (~5–15 s)
 *     Derives a candidate LinkedIn profile URL from the person's name,
 *     then asks Bright Data to scrape it synchronously.  Requires a
 *     derivable URL slug; skipped when the name is missing or ambiguous.
 *
 *   Layer 3 – Deep Lookup by name + company (~10–30 s)
 *     Calls Bright Data's `discover_new / discover_by=name` endpoint with
 *     the person's name and (when available) their company.  More accurate
 *     than the filter API because Bright Data actively resolves the best
 *     matching profile rather than just filtering a static dataset.
 *
 *   Layer 4 – Filter API name search (async, up to ~60 s)
 *     Falls back to the filter-dataset search + snapshot polling flow.
 *     This path is slowest but has the widest reach.
 *
 *   Layer 5 – Error / partial data
 *     All layers have failed.  Throws a structured error so the caller can
 *     surface an appropriate error state in the UI.
 *
 * Progress callbacks:
 *   The orchestrator accepts an optional `onProgress` callback that is
 *   invoked at the start of each layer with a human-readable label.  The
 *   service worker uses this to push `FETCH_PROGRESS` messages to the side
 *   panel so users see live status updates.
 *
 * Usage:
 *   const orchestrator = new WaterfallOrchestrator(cacheManager, apiToken);
 *   orchestrator.onProgress = (label) => { ... };
 *   const personData = await orchestrator.fetch({ name, email, company });
 *
 * @module waterfall-orchestrator
 */

'use strict';

import {
  scrapeByLinkedInUrl,
  pollSnapshotUntilReady,
  downloadSnapshot,
  searchByNameAndFetch,
} from './bright-data-scraper.js';

import { deepLookupByName } from './bright-data-deep-lookup.js';

import { pickBestProfile } from './response-normalizer.js';

const LOG_PREFIX = '[Meeting Intel][Waterfall]';

// ─── Constants ───────────────────────────────────────────────────────────────

/** TTL for newly cached results: 7 days. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-layer timeouts in milliseconds.
 * Layer 2 and 3 can resolve quickly; layer 4 polls a snapshot so it gets
 * the full 60-second budget.
 *
 * @type {Record<string, number>}
 */
const LAYER_TIMEOUTS = {
  urlScrape:   25_000,
  deepLookup:  45_000,
  nameSearch:  90_000,  // includes snapshot polling
};

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FetchPayload
 * @property {string}      name     Full name of the person (required).
 * @property {string}      [email]  Calendar event email address (optional).
 * @property {string|null} [company] Company name for disambiguation (optional).
 */

/**
 * @typedef {Object} LayerResult
 * @property {boolean}        success
 * @property {Array<Object>}  [profiles]   Raw profile objects from the API.
 * @property {string}         [source]     Source label for the normalizer.
 * @property {string}         [error]      Error message when success=false.
 * @property {number}         elapsedMs    Wall-clock time taken by this layer.
 */

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Attempt to derive a likely LinkedIn profile URL from a person's full name.
 *
 * Generates the canonical hyphenated-lowercase slug format.  This is a
 * best-effort heuristic and will be wrong for profiles with custom slugs.
 *
 * @param {string}      name   Full name, e.g. "Jane Doe".
 * @param {string|null} email  Unused here but kept for future hinting.
 * @returns {string|null}      Candidate URL or null if the name is unusable.
 */
function deriveLinkedInUrl(name, email) {
  if (!name || !name.trim()) return null;

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
 * Lowercases, trims, and collapses non-alphanumeric characters to underscores.
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

/**
 * Race a Promise against a timeout.
 * Rejects with a clear error message when the deadline is exceeded.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number}     ms       Deadline in milliseconds.
 * @param {string}     layerName  Used in the rejection message.
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, layerName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[${layerName}] timed out after ${ms / 1000}s`)),
      ms
    );

    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e);  }
    );
  });
}

// ─── WaterfallOrchestrator ───────────────────────────────────────────────────

/**
 * Orchestrates a multi-layer waterfall fetch for LinkedIn profile data.
 *
 * Instantiated once per service-worker lifecycle and reused across requests.
 * The `onProgress` callback is replaced for each fetch invocation by the
 * service-worker message handler so progress messages reach the correct tab.
 */
export class WaterfallOrchestrator {

  /**
   * @param {import('../cache/cache-manager.js').CacheManager} cacheManager
   *   Shared CacheManager instance.
   * @param {string} apiToken
   *   Bright Data API bearer token.
   */
  constructor(cacheManager, apiToken) {
    /** @type {import('../cache/cache-manager.js').CacheManager} */
    this._cache    = cacheManager;

    /** @type {string} */
    this._apiToken = apiToken;

    /**
     * Optional progress callback.  The service worker replaces this before
     * each `fetch()` call with a function that pushes FETCH_PROGRESS messages
     * to the side panel.
     *
     * @type {((label: string) => void) | null}
     */
    this.onProgress = null;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Fire the progress callback if one is registered.
   * Errors from the callback are swallowed so they never abort the waterfall.
   *
   * @param {string} label  Human-readable status string sent to the side panel.
   * @returns {void}
   */
  _notifyProgress(label) {
    if (typeof this.onProgress !== 'function') return;
    try {
      this.onProgress(label);
    } catch (err) {
      console.warn(LOG_PREFIX, 'onProgress callback threw:', err.message);
    }
  }

  /**
   * Execute a single waterfall layer, capturing timing and isolating errors.
   *
   * @param {string}            layerName   Identifier used in logs.
   * @param {string}            progressLabel  Label sent to the progress callback.
   * @param {() => Promise<LayerResult>} fn  The layer's implementation.
   * @param {number}            timeoutMs   Hard deadline for this layer.
   * @returns {Promise<LayerResult>}  Always resolves; never rejects.
   */
  async _runLayer(layerName, progressLabel, fn, timeoutMs) {
    this._notifyProgress(progressLabel);
    console.log(LOG_PREFIX, `Layer: ${layerName}`);

    const start = Date.now();

    try {
      const result = await withTimeout(fn(), timeoutMs, layerName);
      const elapsedMs = Date.now() - start;

      if (result.success) {
        console.log(
          LOG_PREFIX,
          `Layer ${layerName} succeeded in ${elapsedMs}ms – ` +
          `${result.profiles?.length ?? 0} profile(s)`
        );
      } else {
        console.log(
          LOG_PREFIX,
          `Layer ${layerName} returned no data in ${elapsedMs}ms`
        );
      }

      return { ...result, elapsedMs };

    } catch (err) {
      const elapsedMs = Date.now() - start;
      console.warn(
        LOG_PREFIX,
        `Layer ${layerName} failed in ${elapsedMs}ms: ${err.message}`
      );
      return { success: false, error: err.message, elapsedMs };
    }
  }

  // ─── Layer implementations ─────────────────────────────────────────────────

  /**
   * Layer 1: Cache check.
   *
   * @param {string} cacheKey
   * @returns {Promise<LayerResult>}
   */
  async _layerCache(cacheKey) {
    const cached = await this._cache.get(cacheKey);
    if (cached) {
      return { success: true, profiles: null, source: 'cache', _cachedData: cached };
    }
    return { success: false };
  }

  /**
   * Layer 2: Scrape a derived LinkedIn URL synchronously.
   *
   * @param {string}      name
   * @param {string|null} email
   * @returns {Promise<LayerResult>}
   */
  async _layerUrlScrape(name, email) {
    const candidateUrl = deriveLinkedInUrl(name, email);

    if (!candidateUrl) {
      console.log(LOG_PREFIX, 'Layer URL-scrape: no derivable URL, skipping');
      return { success: false, error: 'No derivable LinkedIn URL' };
    }

    console.log(LOG_PREFIX, 'Layer URL-scrape: trying', candidateUrl);

    const scrapeResult = await scrapeByLinkedInUrl(candidateUrl, this._apiToken);
    let profiles;

    if (scrapeResult.mode === 'direct') {
      profiles = scrapeResult.profiles;
    } else {
      // mode === 'snapshot'
      console.log(
        LOG_PREFIX,
        'URL-scrape returned async snapshot, polling:', scrapeResult.snapshotId
      );
      await pollSnapshotUntilReady(scrapeResult.snapshotId, this._apiToken);
      profiles = await downloadSnapshot(scrapeResult.snapshotId, this._apiToken);
    }

    if (!Array.isArray(profiles) || profiles.length === 0) {
      return { success: false, error: 'URL scrape returned empty results' };
    }

    return { success: true, profiles, source: 'brightdata-url' };
  }

  /**
   * Layer 3: Deep Lookup by name + company.
   *
   * @param {string}      name
   * @param {string|null} company
   * @returns {Promise<LayerResult>}
   */
  async _layerDeepLookup(name, company) {
    if (!name) {
      return { success: false, error: 'No name available for deep lookup' };
    }

    console.log(
      LOG_PREFIX,
      `Layer deep-lookup: name="${name}"` +
      (company ? `, company="${company}"` : '')
    );

    const profiles = await deepLookupByName(name, company, this._apiToken);

    if (!profiles || profiles.length === 0) {
      return { success: false, error: 'Deep lookup returned no profiles' };
    }

    return { success: true, profiles, source: 'brightdata-deep' };
  }

  /**
   * Layer 4: Filter API name search (async with snapshot polling).
   *
   * @param {string} name
   * @returns {Promise<LayerResult>}
   */
  async _layerNameSearch(name) {
    if (!name) {
      return { success: false, error: 'No name available for name search' };
    }

    console.log(LOG_PREFIX, `Layer name-search: "${name}"`);

    const profiles = await searchByNameAndFetch(name, this._apiToken);

    if (!Array.isArray(profiles) || profiles.length === 0) {
      return { success: false, error: 'Name search returned no profiles' };
    }

    return { success: true, profiles, source: 'brightdata-name' };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Fetch enriched profile data for a person using the full waterfall cascade.
   *
   * The orchestrator executes layers in sequence, stopping at the first
   * successful result.  Each layer is individually timed and error-isolated.
   *
   * Progress labels are pushed via `onProgress` so the side panel can display
   * live status updates.
   *
   * @param {FetchPayload} payload  Person identity fields from the calendar event.
   * @returns {Promise<import('./response-normalizer.js').PersonData>}
   *   Fully normalised PersonData on success.
   * @throws {Error} When every layer fails and no usable data could be obtained.
   */
  async fetch(payload) {
    const { name, email, company } = payload;
    const identifier = name || email || 'unknown';

    console.log(
      LOG_PREFIX,
      `Waterfall fetch started for: "${identifier}"`
    );

    const cacheKey = `person_${normaliseCacheKey(name || email || identifier)}`;

    // ── Layer 1: Cache ────────────────────────────────────────────────────────
    const cacheResult = await this._runLayer(
      'cache',
      'Checking cache…',
      () => this._layerCache(cacheKey),
      500   // Cache is synchronous-ish; 500 ms is a generous upper bound.
    );

    if (cacheResult.success && cacheResult._cachedData) {
      console.log(LOG_PREFIX, `Cache hit for "${identifier}" – waterfall done`);
      return cacheResult._cachedData;
    }

    // ── Layer 2: URL-based scrape ─────────────────────────────────────────────
    const urlResult = await this._runLayer(
      'url-scrape',
      'Trying LinkedIn scrape…',
      () => this._layerUrlScrape(name, email),
      LAYER_TIMEOUTS.urlScrape
    );

    if (urlResult.success) {
      const data = await this._finalise(urlResult, name, email, cacheKey, identifier);
      if (data) return data;
      // _finalise returned null → data too thin, continue waterfall
    }

    // ── Layer 3: Deep Lookup ──────────────────────────────────────────────────
    const deepResult = await this._runLayer(
      'deep-lookup',
      'Trying deep lookup…',
      () => this._layerDeepLookup(name, company),
      LAYER_TIMEOUTS.deepLookup
    );

    if (deepResult.success) {
      const data = await this._finalise(deepResult, name, email, cacheKey, identifier);
      if (data) return data;
    }

    // ── Layer 4: Name search ──────────────────────────────────────────────────
    const nameResult = await this._runLayer(
      'name-search',
      'Searching by name…',
      () => this._layerNameSearch(name),
      LAYER_TIMEOUTS.nameSearch
    );

    if (nameResult.success) {
      const data = await this._finalise(nameResult, name, email, cacheKey, identifier);
      if (data) return data;
    }

    // ── Layer 5: All layers failed ────────────────────────────────────────────
    this._notifyProgress('No data found');

    const errors = [urlResult, deepResult, nameResult]
      .filter((r) => r.error)
      .map((r) => r.error)
      .join('; ');

    throw new Error(
      `All lookup layers failed for "${identifier}". Errors: ${errors || 'unknown'}`
    );
  }

  /**
   * Normalise raw profiles from a successful layer, attach email, cache the
   * result, and return the final PersonData object.
   *
   * If the normalised data is too thin (name is 'Unknown' AND confidence is
   * 'low'), the method returns `null` instead of a PersonData object.  The
   * caller interprets a `null` return as "this layer didn't produce usable
   * data" and continues to the next waterfall layer.
   *
   * @param {LayerResult}  layerResult
   * @param {string}       name
   * @param {string}       email
   * @param {string}       cacheKey
   * @param {string}       identifier   Human-readable label for logging.
   * @returns {Promise<import('./response-normalizer.js').PersonData|null>}
   */
  async _finalise(layerResult, name, email, cacheKey, identifier) {
    const { profiles, source } = layerResult;

    const personData = pickBestProfile(profiles, name, source);

    if (!personData) {
      console.log(
        LOG_PREFIX,
        `Could not normalise any profile for "${identifier}" from source "${source}" – skipping`
      );
      return null;
    }

    // Quality gate: if the result is essentially empty, skip it so the
    // waterfall continues to a deeper (but slower) layer.
    if (personData.name === 'Unknown' && personData._confidence === 'low') {
      console.log(
        LOG_PREFIX,
        `Layer "${source}" returned low-quality result for "${identifier}" – skipping to next layer`
      );
      return null;
    }

    // Carry over the calendar-event email when the API didn't provide one.
    if (email && !personData.email) {
      personData.email = email;
    }

    // Cache result (non-fatal if it fails).
    try {
      await this._cache.set(cacheKey, personData, CACHE_TTL_MS);
    } catch (cacheErr) {
      console.warn(
        LOG_PREFIX,
        `Failed to cache result for "${identifier}":`,
        cacheErr.message
      );
    }

    console.log(
      LOG_PREFIX,
      `Waterfall complete for "${personData.name}" – ` +
      `source: ${personData._source}, confidence: ${personData._confidence}`
    );

    return personData;
  }
}
