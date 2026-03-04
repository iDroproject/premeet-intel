/**
 * background/api/bright-data-serp.js
 *
 * Bright People Intel – Bright Data SERP API Client (Async Unblocker)
 *
 * Uses the async unblocker pattern:
 *   1. POST /unblocker/req  → sends search request, returns x-response-id
 *   2. GET  /unblocker/get_result → polls for parsed SERP results
 *
 * Extracts LinkedIn profile URLs from Google Search results.
 *
 * @module bright-data-serp
 */

'use strict';

const LOG_PREFIX = '[BPI][SERP]';

// ─── Constants ───────────────────────────────────────────────────────────────

const SERP_SEND_ENDPOINT   = 'https://api.brightdata.com/unblocker/req';
const SERP_RESULT_ENDPOINT = 'https://api.brightdata.com/unblocker/get_result';
const CUSTOMER_ID          = 'hl_cf5c4907';
const ZONE                 = 'serp';

const SERP_POLL_INTERVAL_MS = 2000;
const SERP_MAX_POLL_ATTEMPTS = 15;   // ~30 s total
const SERP_SEND_TIMEOUT_MS  = 15_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the first LinkedIn profile URL from SERP results.
 * Handles multiple response shapes: structured JSON, raw HTML, or plain text.
 *
 * @param {*} data  Parsed response body (object, array, or string).
 * @returns {string|null}
 */
function extractLinkedInUrl(data) {
  // 1. Structured JSON with organic results.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const organic =
      data.organic || data.results || data.organic_results || [];
    for (const result of organic) {
      const url = result?.link || result?.url || result?.href || '';
      if (/linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        console.log(LOG_PREFIX, 'Found LinkedIn URL in organic results:', url);
        return url.split('?')[0];
      }
    }

    // Knowledge graph fallback.
    if (data.knowledge_graph?.website) {
      const kgUrl = data.knowledge_graph.website;
      if (/linkedin\.com\/in\//i.test(kgUrl)) return kgUrl.split('?')[0];
    }
  }

  // 2. Response is a raw array of results.
  if (Array.isArray(data)) {
    for (const result of data) {
      const url = result?.link || result?.url || result?.href || '';
      if (/linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        return url.split('?')[0];
      }
    }
  }

  // 3. Fallback: regex scan the stringified response (handles HTML or text).
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const match = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
  if (match) {
    console.log(LOG_PREFIX, 'Found LinkedIn URL via regex:', match[0]);
    return match[0].split('?')[0];
  }

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search Google via Bright Data async SERP API to find a LinkedIn profile URL.
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

  // ── Step 1: Send request ────────────────────────────────────────────────
  const sendUrl =
    `${SERP_SEND_ENDPOINT}?customer=${CUSTOMER_ID}&zone=${ZONE}`;

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), SERP_SEND_TIMEOUT_MS);

  let responseId;
  try {
    const sendResponse = await fetch(sendUrl, {
      method:  'POST',
      headers: authHeaders(apiToken),
      body:    JSON.stringify({ url: searchUrl }),
      signal:  controller.signal,
    });
    clearTimeout(timerId);

    responseId = sendResponse.headers.get('x-response-id');

    if (!responseId) {
      // Some API versions return the response_id in the body.
      try {
        const body = await sendResponse.json();
        responseId = body?.response_id || body?.id;
      } catch (_) { /* ignore parse errors */ }
    }

    if (!responseId) {
      const errBody = await sendResponse.text().catch(() => '');
      console.error(LOG_PREFIX, `SERP send HTTP ${sendResponse.status}, no x-response-id. Body:`, errBody.slice(0, 300));
      throw new Error(
        `SERP send returned HTTP ${sendResponse.status} but no x-response-id header`
      );
    }

    console.log(LOG_PREFIX, 'SERP request sent, response_id:', responseId);
  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') {
      throw new Error(`SERP send timed out after ${SERP_SEND_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  // ── Step 2: Poll for result ─────────────────────────────────────────────
  const resultUrl =
    `${SERP_RESULT_ENDPOINT}?customer=${CUSTOMER_ID}&zone=${ZONE}&response_id=${responseId}`;

  for (let attempt = 1; attempt <= SERP_MAX_POLL_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `Polling SERP result (attempt ${attempt}/${SERP_MAX_POLL_ATTEMPTS})`);

    try {
      const res = await fetch(resultUrl, {
        method:  'GET',
        headers: { 'Authorization': `Bearer ${apiToken}` },
      });

      if (res.status === 200) {
        const contentType = res.headers.get('content-type') || '';
        let data;

        if (contentType.includes('application/json')) {
          data = await res.json();
        } else {
          data = await res.text();
        }

        // Empty or pending response — keep polling.
        if (!data || (typeof data === 'string' && data.trim().length === 0)) {
          await sleep(SERP_POLL_INTERVAL_MS);
          continue;
        }

        return extractLinkedInUrl(data);
      }

      // 202 or other non-200 → still processing.
      if (res.status === 202) {
        await sleep(SERP_POLL_INTERVAL_MS);
        continue;
      }

      // Unexpected error.
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `SERP get_result returned HTTP ${res.status}: ${errBody.slice(0, 200)}`
      );
    } catch (err) {
      if (attempt === SERP_MAX_POLL_ATTEMPTS) throw err;
      console.warn(LOG_PREFIX, `SERP poll attempt ${attempt} failed:`, err.message);
      await sleep(SERP_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `SERP result not ready after ${SERP_MAX_POLL_ATTEMPTS} attempts`
  );
}
