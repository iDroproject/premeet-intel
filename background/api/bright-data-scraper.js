/**
 * background/api/bright-data-scraper.js
 *
 * Meeting Intel – Bright Data Web Scraper API Client
 *
 * Provides two lookup strategies:
 *   1. scrapeByLinkedInUrl()  – synchronous scrape of a known LinkedIn profile URL.
 *      Returns profile data immediately (HTTP 200) or a snapshot_id for async
 *      retrieval (HTTP 202).
 *
 *   2. searchByName()         – filter-dataset search when no LinkedIn URL is
 *      available. Returns a snapshot_id; callers must poll then download
 *      separately using pollSnapshot() and downloadSnapshot().
 *
 * All network I/O happens here inside the service worker, which has the
 * host_permissions required to reach api.brightdata.com without CORS issues.
 *
 * @module bright-data-scraper
 */

'use strict';

const LOG_PREFIX = '[Meeting Intel][BrightData]';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL        = 'https://api.brightdata.com';
const DATASET_ID      = 'gd_l1viktl72bvl7bjuj0';
const SCRAPE_ENDPOINT = `${BASE_URL}/datasets/v3/scrape?dataset_id=${DATASET_ID}&format=json`;
const FILTER_ENDPOINT = `${BASE_URL}/datasets/filter`;
const SNAPSHOT_BASE   = `${BASE_URL}/datasets/snapshots`;

/**
 * Maximum number of polling attempts before giving up on a snapshot.
 * At ~2 s per interval this is ~60 s total.
 *
 * @type {number}
 */
const MAX_POLL_ATTEMPTS = 30;

/**
 * Milliseconds between snapshot status polls.
 *
 * @type {number}
 */
const POLL_INTERVAL_MS = 2000;

/**
 * Maximum number of profile records to return from a name search.
 *
 * @type {number}
 */
const NAME_SEARCH_RECORD_LIMIT = 5;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ScrapeResult
 * @property {'direct'|'snapshot'} mode
 *   - `direct`   – profile data available immediately in `profiles`.
 *   - `snapshot` – processing; use `snapshotId` to poll later.
 * @property {Array<Object>}  [profiles]    Raw profile objects (mode=direct).
 * @property {string}         [snapshotId]  Snapshot ID (mode=snapshot).
 */

/**
 * @typedef {Object} SnapshotStatus
 * @property {string} status  'ready' | 'running' | 'failed' | string
 * @property {string} [id]
 */

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Build the shared Authorization header.
 *
 * @param {string} apiToken
 * @returns {Record<string, string>}
 */
function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

/**
 * Perform a fetch and throw a descriptive error on non-OK responses.
 *
 * @param {string}      url
 * @param {RequestInit} options
 * @returns {Promise<Response>}
 * @throws {Error} Descriptive error including HTTP status and body excerpt.
 */
async function fetchWithErrorHandling(url, options) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error reaching ${url}: ${networkErr.message}`);
  }

  if (!response.ok && response.status !== 202) {
    let bodyExcerpt = '';
    try {
      const text = await response.text();
      bodyExcerpt = text.slice(0, 200);
    } catch (_) {
      // Ignore body-read errors; the status code is already informative.
    }
    throw new Error(
      `Bright Data API returned HTTP ${response.status} for ${url}` +
      (bodyExcerpt ? `: ${bodyExcerpt}` : '')
    );
  }

  return response;
}

/**
 * Sleep for `ms` milliseconds.
 * Used during snapshot polling to avoid hammering the API.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scrape a LinkedIn profile by its public URL using the synchronous
 * Bright Data scrape endpoint.
 *
 * The API may respond with:
 *   - HTTP 200 + JSON array → data is ready immediately (mode = 'direct').
 *   - HTTP 202 + `{ snapshot_id }` → data is still processing (mode = 'snapshot').
 *
 * @param {string} linkedInUrl  Full LinkedIn profile URL,
 *                              e.g. "https://www.linkedin.com/in/username/".
 * @param {string} apiToken     Bright Data API bearer token.
 * @returns {Promise<ScrapeResult>}
 * @throws {Error} On network failure or non-recoverable API error.
 */
export async function scrapeByLinkedInUrl(linkedInUrl, apiToken) {
  console.log(LOG_PREFIX, 'Scraping LinkedIn URL:', linkedInUrl);

  const response = await fetchWithErrorHandling(SCRAPE_ENDPOINT, {
    method:  'POST',
    headers: authHeaders(apiToken),
    body:    JSON.stringify([{ url: linkedInUrl }]),
  });

  // HTTP 202 means Bright Data accepted the job but hasn't finished yet.
  if (response.status === 202) {
    const body = await response.json();
    const snapshotId = body?.snapshot_id;

    if (!snapshotId) {
      throw new Error('Received HTTP 202 from Bright Data but no snapshot_id in body');
    }

    console.log(LOG_PREFIX, 'Scrape queued, snapshot_id:', snapshotId);
    return { mode: 'snapshot', snapshotId };
  }

  // HTTP 200 – data available immediately.
  const profiles = await response.json();

  if (!Array.isArray(profiles)) {
    throw new Error(
      'Expected array from Bright Data scrape endpoint, got: ' +
      typeof profiles
    );
  }

  console.log(LOG_PREFIX, `Scrape returned ${profiles.length} profile(s) directly`);
  return { mode: 'direct', profiles };
}

/**
 * Trigger a filter-dataset search by person name.
 *
 * This is an async operation on Bright Data's side; the function returns
 * a snapshot_id immediately. Use `pollSnapshotUntilReady()` and
 * `downloadSnapshot()` to retrieve the results.
 *
 * @param {string} name      Full name to search for, e.g. "Jane Doe".
 * @param {string} apiToken  Bright Data API bearer token.
 * @returns {Promise<string>} The snapshot_id to poll.
 * @throws {Error} On network failure or API error.
 */
export async function searchByName(name, apiToken) {
  console.log(LOG_PREFIX, 'Searching by name:', name);

  const response = await fetchWithErrorHandling(FILTER_ENDPOINT, {
    method:  'POST',
    headers: authHeaders(apiToken),
    body:    JSON.stringify({
      dataset_id:    DATASET_ID,
      filter:        { name: 'name', operator: '=', value: name },
      records_limit: NAME_SEARCH_RECORD_LIMIT,
    }),
  });

  const body = await response.json();
  const snapshotId = body?.snapshot_id;

  if (!snapshotId) {
    throw new Error(
      'Bright Data filter API did not return a snapshot_id. Body: ' +
      JSON.stringify(body).slice(0, 200)
    );
  }

  console.log(LOG_PREFIX, 'Name search snapshot_id:', snapshotId);
  return snapshotId;
}

/**
 * Poll a Bright Data snapshot until its status is "ready" or until
 * `MAX_POLL_ATTEMPTS` is exhausted.
 *
 * @param {string} snapshotId  Snapshot ID returned by searchByName or a
 *                             202 response from scrapeByLinkedInUrl.
 * @param {string} apiToken    Bright Data API bearer token.
 * @returns {Promise<void>}    Resolves when the snapshot is ready.
 * @throws {Error} If the snapshot fails or the poll limit is exceeded.
 */
export async function pollSnapshotUntilReady(snapshotId, apiToken) {
  const statusUrl = `${SNAPSHOT_BASE}/${snapshotId}`;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `Polling snapshot ${snapshotId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

    const response = await fetchWithErrorHandling(statusUrl, {
      method:  'GET',
      headers: authHeaders(apiToken),
    });

    /** @type {SnapshotStatus} */
    const status = await response.json();

    if (status.status === 'ready') {
      console.log(LOG_PREFIX, `Snapshot ${snapshotId} is ready`);
      return;
    }

    if (status.status === 'failed') {
      throw new Error(`Bright Data snapshot ${snapshotId} failed`);
    }

    // Status is still 'running' (or unknown) – wait before next poll.
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Snapshot ${snapshotId} did not become ready after ${MAX_POLL_ATTEMPTS} attempts`
  );
}

/**
 * Download the JSON results for a completed Bright Data snapshot.
 *
 * Call this only after `pollSnapshotUntilReady()` has resolved.
 *
 * @param {string} snapshotId  Snapshot ID.
 * @param {string} apiToken    Bright Data API bearer token.
 * @returns {Promise<Array<Object>>} Array of raw profile objects.
 * @throws {Error} On network failure or unexpected response shape.
 */
export async function downloadSnapshot(snapshotId, apiToken) {
  const downloadUrl = `${SNAPSHOT_BASE}/${snapshotId}/download?format=json`;

  console.log(LOG_PREFIX, 'Downloading snapshot:', snapshotId);

  const response = await fetchWithErrorHandling(downloadUrl, {
    method:  'GET',
    headers: authHeaders(apiToken),
  });

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error(
      'Expected array from Bright Data snapshot download, got: ' + typeof data
    );
  }

  console.log(LOG_PREFIX, `Downloaded ${data.length} record(s) from snapshot ${snapshotId}`);
  return data;
}

/**
 * High-level helper: search by name and fully await the results.
 *
 * Combines `searchByName`, `pollSnapshotUntilReady`, and `downloadSnapshot`
 * into one awaitable call for callers that don't need the snapshot_id.
 *
 * @param {string} name      Full name to search for.
 * @param {string} apiToken  Bright Data API bearer token.
 * @returns {Promise<Array<Object>>} Raw profile objects matching the name.
 * @throws {Error} On any failure in the pipeline.
 */
export async function searchByNameAndFetch(name, apiToken) {
  const snapshotId = await searchByName(name, apiToken);
  await pollSnapshotUntilReady(snapshotId, apiToken);
  return downloadSnapshot(snapshotId, apiToken);
}
