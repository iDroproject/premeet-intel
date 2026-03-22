/**
 * background/api/data-scraper.js
 *
 * PreMeet – Web Scraper API Client (WSA)
 *
 * Provides LinkedIn profile scraping:
 *   - scrapeByLinkedInUrl()  – scrape a LinkedIn profile URL to get profile data
 *     including the LinkedIn ID. Returns data immediately (HTTP 200) or a
 *     snapshot_id for async retrieval (HTTP 202).
 *
 * Also provides shared snapshot utilities:
 *   - pollSnapshotUntilReady()
 *   - downloadSnapshot()
 *   - extractLinkedInId()
 *
 * @module data-scraper
 */

'use strict';

const LOG_PREFIX = '[PreMeet][Scraper]';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL        = 'https://api.brightdata.com';
const DATASET_ID      = 'gd_l1viktl72bvl7bjuj0';
const SCRAPE_ENDPOINT =
  `${BASE_URL}/datasets/v3/scrape?dataset_id=${DATASET_ID}&notify=false&include_errors=true`;
const SNAPSHOT_BASE   = `${BASE_URL}/datasets/snapshots`;

const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS  = 2000;

// ─── Internal Helpers ────────────────────────────────────────────────────────

function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

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
    } catch (_) { /* ignore */ }
    throw new Error(
      `API returned HTTP ${response.status} for ${url}` +
      (bodyExcerpt ? `: ${bodyExcerpt}` : '')
    );
  }

  return response;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract the LinkedIn ID slug from a LinkedIn profile URL.
 *
 * @param {string} url  e.g. "https://www.linkedin.com/in/john-doe-123"
 * @returns {string|null}  e.g. "john-doe-123"
 */
export function extractLinkedInIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  return match ? decodeURIComponent(match[1]).replace(/\/+$/, '') : null;
}

/**
 * Extract the best LinkedIn ID from a raw profile object.
 * Prefers the `linkedin_id` field (shorter, used by Filter API) over the
 * URL slug `id` field.
 *
 * @param {Object} profile  Raw profile from scraper.
 * @param {string} [fallbackUrl]  LinkedIn URL to extract ID from.
 * @returns {string|null}
 */
export function extractLinkedInId(profile, fallbackUrl) {
  if (profile?.linkedin_id) return profile.linkedin_id;
  if (profile?.id) return profile.id;
  if (profile?.url) return extractLinkedInIdFromUrl(profile.url);
  if (fallbackUrl) return extractLinkedInIdFromUrl(fallbackUrl);
  return null;
}

/**
 * Scrape a LinkedIn profile by its public URL using the WSA scrape endpoint.
 *
 * @param {string} linkedInUrl  Full LinkedIn profile URL.
 * @param {string} apiToken     API bearer token.
 * @returns {Promise<{mode: 'direct'|'snapshot', profiles?: Array, snapshotId?: string}>}
 */
export async function scrapeByLinkedInUrl(linkedInUrl, apiToken) {
  console.log(LOG_PREFIX, 'Scraping LinkedIn URL:', linkedInUrl);

  const response = await fetchWithErrorHandling(SCRAPE_ENDPOINT, {
    method:  'POST',
    headers: authHeaders(apiToken),
    body:    JSON.stringify({ input: [{ url: linkedInUrl }] }),
  });

  // HTTP 202 — job accepted, snapshot polling required.
  if (response.status === 202) {
    const body = await response.json();
    const snapshotId = body?.snapshot_id;
    if (!snapshotId) {
      throw new Error('Received HTTP 202 but no snapshot_id in body');
    }
    console.log(LOG_PREFIX, 'Scrape queued, snapshot_id:', snapshotId);
    return { mode: 'snapshot', snapshotId };
  }

  // HTTP 200 — data available immediately.
  // The API may return a single object or an array depending on input count.
  const raw = await response.json();
  const profiles = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);

  // Filter out error entries (e.g. dead_page, private profiles).
  const valid = profiles.filter(p => !p.error && !p.error_code);

  console.log(LOG_PREFIX, `Scrape returned ${profiles.length} profile(s) directly, ${valid.length} valid`);
  return { mode: 'direct', profiles: valid };
}

/**
 * Poll a snapshot until its status is "ready".
 *
 * @param {string} snapshotId
 * @param {string} apiToken
 * @returns {Promise<void>}
 */
export async function pollSnapshotUntilReady(snapshotId, apiToken) {
  const statusUrl = `${SNAPSHOT_BASE}/${snapshotId}`;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `Polling snapshot ${snapshotId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

    const response = await fetchWithErrorHandling(statusUrl, {
      method:  'GET',
      headers: authHeaders(apiToken),
    });

    const status = await response.json();

    if (status.status === 'ready') {
      console.log(LOG_PREFIX, `Snapshot ${snapshotId} is ready`);
      return;
    }

    if (status.status === 'failed') {
      throw new Error(`Snapshot ${snapshotId} failed`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Snapshot ${snapshotId} did not become ready after ${MAX_POLL_ATTEMPTS} attempts`
  );
}

/**
 * Download the JSON results for a completed snapshot.
 *
 * @param {string} snapshotId
 * @param {string} apiToken
 * @returns {Promise<Array<Object>>}
 */
export async function downloadSnapshot(snapshotId, apiToken) {
  const downloadUrl = `${SNAPSHOT_BASE}/${snapshotId}/download?format=json`;
  console.log(LOG_PREFIX, 'Downloading snapshot:', snapshotId);

  const response = await fetchWithErrorHandling(downloadUrl, {
    method:  'GET',
    headers: authHeaders(apiToken),
  });

  // Handle JSON, NDJSON, or non-JSON text responses gracefully.
  const rawText = await response.text();
  const trimmed = rawText.trim();

  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    throw new Error(`Snapshot download returned non-JSON: "${trimmed.slice(0, 100)}"`);
  }

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (_) {
    // NDJSON: one JSON object per line.
    const lines = trimmed.split('\n').filter(l => l.trim());
    data = [];
    for (const line of lines) {
      try { data.push(JSON.parse(line)); } catch (_e) { /* skip */ }
    }
    if (data.length === 0) throw new Error('Could not parse snapshot response as JSON or NDJSON');
    console.log(LOG_PREFIX, `Parsed ${data.length} record(s) from NDJSON`);
  }

  if (!Array.isArray(data)) {
    data = [data];
  }

  console.log(LOG_PREFIX, `Downloaded ${data.length} record(s) from snapshot ${snapshotId}`);
  return data;
}
