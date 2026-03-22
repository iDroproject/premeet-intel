/**
 * background/api/serp-api.js
 *
 * PreMeet – SERP API Client (Async Unblocker)
 *
 * Uses the async unblocker pattern:
 *   1. POST /unblocker/req  → sends search request, returns x-response-id
 *   2. GET  /unblocker/get_result → polls for parsed SERP results
 *
 * Extracts LinkedIn profile URLs from Google Search results.
 *
 * @module serp-api
 */

'use strict';

const LOG_PREFIX = '[PreMeet][SERP]';

// ─── Constants ───────────────────────────────────────────────────────────────

const SERP_SEND_ENDPOINT   = 'https://api.brightdata.com/unblocker/req';
const SERP_RESULT_ENDPOINT = 'https://api.brightdata.com/unblocker/get_result';
const DEFAULT_CUSTOMER_ID  = 'hl_cf5c4907';
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
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        console.log(LOG_PREFIX, 'Found LinkedIn URL in organic results:', url);
        return url.split('?')[0];
      }
    }

    // Knowledge graph fallback.
    if (data.knowledge_graph?.website) {
      const kgUrl = data.knowledge_graph.website;
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(kgUrl)) return kgUrl.split('?')[0];
    }
  }

  // 2. Response is a raw array of results.
  if (Array.isArray(data)) {
    for (const result of data) {
      const url = result?.link || result?.url || result?.href || '';
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        return url.split('?')[0];
      }
    }
  }

  // 3. Fallback: regex scan the stringified response (handles HTML or text).
  //    LinkedIn URLs can use country subdomains (il.linkedin.com, ca.linkedin.com, etc.)
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const match = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
  if (match) {
    console.log(LOG_PREFIX, 'Found LinkedIn URL via regex:', match[0]);
    // Normalize to www.linkedin.com
    return match[0].split('?')[0].replace(/\/\/[a-z]{2,3}\.linkedin/, '//www.linkedin');
  }

  return null;
}

// ─── Shared SERP Request Helper ──────────────────────────────────────────

/**
 * Send a SERP request and poll for results. Returns raw response data.
 *
 * @param {string} searchUrl  Full Google search URL.
 * @param {string} apiToken   API bearer token.
 * @param {string} [customerId]
 * @returns {Promise<*>} Parsed response (object, array, or string).
 */
async function _serpRequest(searchUrl, apiToken, customerId) {
  const cid = customerId || DEFAULT_CUSTOMER_ID;

  // Step 1: Send request.
  const sendUrl = `${SERP_SEND_ENDPOINT}?customer=${cid}&zone=${ZONE}`;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), SERP_SEND_TIMEOUT_MS);

  let responseId;
  try {
    const sendResponse = await fetch(sendUrl, {
      method: 'POST',
      headers: authHeaders(apiToken),
      body: JSON.stringify({ url: searchUrl }),
      signal: controller.signal,
    });
    clearTimeout(timerId);

    responseId = sendResponse.headers.get('x-response-id');
    if (!responseId) {
      try {
        const body = await sendResponse.json();
        responseId = body?.response_id || body?.id;
      } catch (_) {}
    }
    if (!responseId) {
      throw new Error(`SERP send returned HTTP ${sendResponse.status} but no x-response-id`);
    }
    console.log(LOG_PREFIX, 'SERP request sent, response_id:', responseId);
  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') throw new Error(`SERP send timed out`);
    throw err;
  }

  // Step 2: Poll for result.
  const resultUrl = `${SERP_RESULT_ENDPOINT}?customer=${cid}&zone=${ZONE}&response_id=${responseId}`;

  for (let attempt = 1; attempt <= SERP_MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(resultUrl, {
        method: 'GET',
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
        if (!data || (typeof data === 'string' && data.trim().length === 0)) {
          await sleep(SERP_POLL_INTERVAL_MS);
          continue;
        }
        return data;
      }

      if (res.status === 202) {
        await sleep(SERP_POLL_INTERVAL_MS);
        continue;
      }

      const errBody = await res.text().catch(() => '');
      throw new Error(`SERP get_result HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    } catch (err) {
      if (attempt === SERP_MAX_POLL_ATTEMPTS) throw err;
      console.warn(LOG_PREFIX, `SERP poll attempt ${attempt} failed:`, err.message);
      await sleep(SERP_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`SERP result not ready after ${SERP_MAX_POLL_ATTEMPTS} attempts`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search Google via async SERP API to find a LinkedIn profile URL.
 *
 * @param {string} query      Search query (email, "name company", etc.)
 * @param {string} apiToken   API bearer token.
 * @param {string} [customerId]  customer ID (defaults to internal).
 * @returns {Promise<string|null>} LinkedIn URL or null if not found.
 */
export async function serpFindLinkedInUrl(query, apiToken, customerId) {
  if (!query || !query.trim()) return null;

  const cid = customerId || DEFAULT_CUSTOMER_ID;
  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in ' + query)}&hl=en&gl=us&num=5`;

  console.log(LOG_PREFIX, 'SERP search:', query);

  // ── Step 1: Send request ────────────────────────────────────────────────
  const sendUrl =
    `${SERP_SEND_ENDPOINT}?customer=${cid}&zone=${ZONE}`;

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
    `${SERP_RESULT_ENDPOINT}?customer=${cid}&zone=${ZONE}&response_id=${responseId}`;

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

/**
 * Search Google for company information via SERP and extract structured data.
 *
 * @param {string} companyName  Company name to search for.
 * @param {string} apiToken     API bearer token.
 * @param {string} [customerId]
 * @returns {Promise<Object|null>} Structured company info or null.
 */
export async function serpSearchCompanyInfo(companyName, apiToken, customerId) {
  if (!companyName || !companyName.trim()) return null;

  const query = `${companyName} company overview products services founded`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&num=10`;

  console.log(LOG_PREFIX, 'SERP company search:', companyName);

  try {
    const data = await _serpRequest(searchUrl, apiToken, customerId);
    return extractCompanyInfo(data, companyName);
  } catch (err) {
    console.warn(LOG_PREFIX, 'SERP company search failed:', err.message);
    return null;
  }
}

/**
 * Extract structured company info from SERP results (JSON or HTML).
 */
function extractCompanyInfo(data, companyName) {
  const result = {
    company_description: null,
    company_website: null,
    company_industry: null,
    company_founded_year: null,
    company_headquarters: null,
    products_services: null,
    company_funding: null,
    recent_news: null,
  };

  // Collect snippets from organic results.
  let snippets = [];
  const nameLower = companyName.toLowerCase();

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const organic = data.organic || data.results || data.organic_results || [];
    for (const r of organic) {
      const snippet = r?.snippet || r?.description || '';
      const title = r?.title || '';
      const link = r?.link || r?.url || '';
      if (snippet) snippets.push({ snippet, title, link });
    }

    // Knowledge graph.
    if (data.knowledge_graph) {
      const kg = data.knowledge_graph;
      if (kg.description) result.company_description = kg.description;
      if (kg.website) result.company_website = kg.website;
      if (kg.type) result.company_industry = kg.type;
      if (kg.founded) result.company_founded_year = String(kg.founded);
      if (kg.headquarters) result.company_headquarters = kg.headquarters;
    }
  }

  // Fallback: regex extract from raw HTML/text.
  const text = typeof data === 'string' ? data : JSON.stringify(data);

  // Extract founded year.
  if (!result.company_founded_year) {
    const foundedMatch = text.match(/(?:founded|established|started)\s+(?:in\s+)?(\d{4})/i);
    if (foundedMatch) result.company_founded_year = foundedMatch[1];
  }

  // Extract HQ.
  if (!result.company_headquarters) {
    const hqMatch = text.match(/(?:headquartered|based|hq)\s+(?:in\s+)?([A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+)/i);
    if (hqMatch) result.company_headquarters = hqMatch[1].trim();
  }

  // Build description from top relevant snippets.
  if (!result.company_description && snippets.length > 0) {
    const relevant = snippets
      .filter(s => s.snippet.toLowerCase().includes(nameLower) || s.title.toLowerCase().includes(nameLower))
      .slice(0, 3);
    if (relevant.length > 0) {
      result.company_description = relevant.map(s => s.snippet).join(' ').slice(0, 500);
    }
  }

  // Extract website.
  if (!result.company_website && snippets.length > 0) {
    const siteSnippet = snippets.find(s =>
      s.link && !s.link.includes('linkedin.com') && !s.link.includes('wikipedia.org')
      && s.title.toLowerCase().includes(nameLower)
    );
    if (siteSnippet) result.company_website = siteSnippet.link;
  }

  // Extract funding.
  const fundingMatch = text.match(/(?:raised|funding|series [a-z])\s*[:\-]?\s*\$?([\d,.]+\s*(?:million|billion|m|b|M|B))/i);
  if (fundingMatch) result.company_funding = fundingMatch[0].trim();

  // News: grab first snippet that looks like recent news.
  const newsSnippet = snippets.find(s =>
    /\d{4}|announced|launched|acquired|partnership|raised/i.test(s.snippet)
  );
  if (newsSnippet) result.recent_news = newsSnippet.snippet.slice(0, 250);

  const populated = Object.values(result).filter(Boolean).length;
  console.log(LOG_PREFIX, `Company SERP extracted ${populated}/8 fields for "${companyName}"`);

  return populated > 0 ? result : null;
}
