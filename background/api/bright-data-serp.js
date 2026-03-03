/**
 * background/api/bright-data-serp.js
 *
 * Bright People Intel – Bright Data SERP & Business Enriched API Client
 *
 * Provides:
 *   1. serpFindLinkedInUrl() – Google Search via SERP API to discover
 *      a person's LinkedIn profile URL from their email or name.
 *   2. scrapeBusinessEnriched() – Scrape the Employees Business Enriched
 *      dataset for additional company/role context.
 *
 * @module bright-data-serp
 */

'use strict';

import {
  pollSnapshotUntilReady,
  downloadSnapshot,
} from './bright-data-scraper.js';

const LOG_PREFIX = '[BPI][SERP]';

// ─── Constants ───────────────────────────────────────────────────────────────

const SERP_ENDPOINT = 'https://api.brightdata.com/request';
const SERP_ZONE     = 'serp';
const SERP_TIMEOUT_MS = 15_000;

const BASE_URL = 'https://api.brightdata.com';
const BUSINESS_ENRICHED_DATASET_ID = 'gd_m18zt6ec11wfqohyrs';
const BUSINESS_ENRICHED_ENDPOINT =
  `${BASE_URL}/datasets/v3/scrape?dataset_id=${BUSINESS_ENRICHED_DATASET_ID}&format=json`;
const BUSINESS_ENRICHED_TIMEOUT_MS = 25_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

/**
 * Extract the first LinkedIn profile URL from SERP organic results.
 * Looks for URLs matching linkedin.com/in/ (personal profiles).
 *
 * @param {Object} serpData  Raw SERP JSON response.
 * @returns {string|null}    LinkedIn profile URL or null.
 */
function extractLinkedInUrlFromSerp(serpData) {
  // The SERP API may return results in different structures.
  const organic =
    serpData?.organic ||
    serpData?.results ||
    serpData?.organic_results ||
    [];

  // Also check if the response is a raw array.
  const results = Array.isArray(serpData) ? serpData : organic;

  for (const result of results) {
    const url = result?.link || result?.url || result?.href || '';
    if (/linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
      console.log(LOG_PREFIX, 'Found LinkedIn URL in SERP results:', url);
      return url.split('?')[0]; // strip query params
    }
  }

  // Fallback: search in nested structures.
  if (serpData?.knowledge_graph?.website) {
    const kgUrl = serpData.knowledge_graph.website;
    if (/linkedin\.com\/in\//i.test(kgUrl)) return kgUrl.split('?')[0];
  }

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search Google via Bright Data SERP API to find a LinkedIn profile URL.
 *
 * @param {string} query    Search query (email, "name company", etc.)
 * @param {string} apiToken Bright Data API bearer token.
 * @returns {Promise<string|null>} LinkedIn URL or null if not found.
 */
export async function serpFindLinkedInUrl(query, apiToken) {
  if (!query || !query.trim()) return null;

  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in ' + query)}&hl=en&gl=us&num=5`;

  console.log(LOG_PREFIX, 'SERP search:', query);

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), SERP_TIMEOUT_MS);

  try {
    const response = await fetch(SERP_ENDPOINT, {
      method: 'POST',
      headers: authHeaders(apiToken),
      body: JSON.stringify({
        zone: SERP_ZONE,
        url: searchUrl,
        format: 'json',
      }),
      signal: controller.signal,
    });

    clearTimeout(timerId);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SERP API returned HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    return extractLinkedInUrlFromSerp(data);

  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') {
      throw new Error(`SERP search timed out after ${SERP_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

/**
 * Scrape the Employees Business Enriched dataset for a LinkedIn URL.
 *
 * @param {string} linkedInUrl  LinkedIn profile URL.
 * @param {string} apiToken     Bright Data API bearer token.
 * @returns {Promise<{mode: 'direct'|'snapshot', profiles?: Array, snapshotId?: string}>}
 */
export async function scrapeBusinessEnriched(linkedInUrl, apiToken) {
  console.log(LOG_PREFIX, 'Business Enriched scrape:', linkedInUrl);

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), BUSINESS_ENRICHED_TIMEOUT_MS);

  try {
    const response = await fetch(BUSINESS_ENRICHED_ENDPOINT, {
      method: 'POST',
      headers: authHeaders(apiToken),
      body: JSON.stringify([{ url: linkedInUrl }]),
      signal: controller.signal,
    });

    clearTimeout(timerId);

    if (response.status === 202) {
      const body = await response.json();
      const snapshotId = body?.snapshot_id;
      if (!snapshotId) {
        throw new Error('Business Enriched 202 response missing snapshot_id');
      }
      console.log(LOG_PREFIX, 'Business Enriched async, snapshot:', snapshotId);
      return { mode: 'snapshot', snapshotId };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Business Enriched API HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const profiles = await response.json();
    console.log(LOG_PREFIX, `Business Enriched returned ${Array.isArray(profiles) ? profiles.length : 0} result(s)`);
    return { mode: 'direct', profiles: Array.isArray(profiles) ? profiles : [] };

  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') {
      throw new Error(`Business Enriched timed out after ${BUSINESS_ENRICHED_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}
