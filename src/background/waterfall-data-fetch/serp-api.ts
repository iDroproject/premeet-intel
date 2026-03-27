// PreMeet – SERP API Client (Async Unblocker)
// Uses the async unblocker pattern:
//   1. POST /unblocker/req  → sends search request, returns x-response-id
//   2. GET  /unblocker/get_result → polls for parsed SERP results
// Extracts LinkedIn profile URLs from Google Search results.

import { proxyFetch } from './brightdata-proxy';
import type { CompanyInfo } from './types';

const LOG_PREFIX = '[PreMeet][SERP]';

const DEFAULT_CUSTOMER_ID = 'hl_cf5c4907';
const ZONE = 'serp';

const SERP_POLL_INTERVAL_MS = 2000;
const SERP_MAX_POLL_ATTEMPTS = 15; // ~30s total
const SERP_SEND_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLinkedInUrl(data: unknown): string | null {
  // 1. Structured JSON with organic results.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const organic = (d.organic || d.results || d.organic_results || []) as Array<Record<string, unknown>>;
    for (const result of organic) {
      const url = String(result?.link || result?.url || result?.href || '');
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        console.log(LOG_PREFIX, 'Found LinkedIn URL in organic results:', url);
        return url.split('?')[0];
      }
    }

    // Knowledge graph fallback.
    const kg = (d.knowledge_graph || {}) as Record<string, unknown>;
    if (kg.website) {
      const kgUrl = String(kg.website);
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(kgUrl)) return kgUrl.split('?')[0];
    }
  }

  // 2. Response is a raw array of results.
  if (Array.isArray(data)) {
    for (const result of data) {
      const url = String(result?.link || result?.url || result?.href || '');
      if (/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
        return url.split('?')[0];
      }
    }
  }

  // 3. Fallback: regex scan the stringified response (handles HTML or text).
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const match = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
  if (match) {
    console.log(LOG_PREFIX, 'Found LinkedIn URL via regex:', match[0]);
    return match[0].split('?')[0].replace(/\/\/[a-z]{2,3}\.linkedin/, '//www.linkedin');
  }

  return null;
}

/**
 * Send a SERP request via the async unblocker and poll for results.
 * Returns the raw response data (object, array, or string).
 */
async function _serpRequest(searchUrl: string): Promise<unknown> {
  const sendPath = `/unblocker/req?customer=${DEFAULT_CUSTOMER_ID}&zone=${ZONE}`;

  console.log(LOG_PREFIX, 'Sending SERP request:', searchUrl.slice(0, 120));

  // Step 1: Send request
  const sendResponse = await proxyFetch(sendPath, 'POST', { url: searchUrl });

  let responseId = sendResponse.headers.get('x-response-id');

  if (!responseId) {
    // Some API versions return the response_id in the body
    try {
      const body = await sendResponse.clone().json();
      responseId = body?.response_id || body?.id;
    } catch {
      // ignore parse errors
    }
  }

  if (!responseId) {
    const errBody = await sendResponse.text().catch(() => '');
    console.error(LOG_PREFIX, `SERP send HTTP ${sendResponse.status}, no x-response-id. Body:`, errBody.slice(0, 300));
    throw new Error(`SERP send returned HTTP ${sendResponse.status} but no x-response-id header`);
  }

  console.log(LOG_PREFIX, 'SERP request sent, response_id:', responseId);

  // Step 2: Poll for result
  const resultPath = `/unblocker/get_result?customer=${DEFAULT_CUSTOMER_ID}&zone=${ZONE}&response_id=${responseId}`;

  for (let attempt = 1; attempt <= SERP_MAX_POLL_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `Polling SERP result (attempt ${attempt}/${SERP_MAX_POLL_ATTEMPTS})`);

    try {
      const res = await proxyFetch(resultPath, 'GET');

      if (res.status === 200) {
        const contentType = res.headers.get('content-type') || '';
        let data: unknown;

        if (contentType.includes('application/json')) {
          data = await res.json();
        } else {
          data = await res.text();
        }

        // Empty or pending response — keep polling
        if (!data || (typeof data === 'string' && data.trim().length === 0)) {
          await sleep(SERP_POLL_INTERVAL_MS);
          continue;
        }

        return data;
      }

      // 202 or other non-200 → still processing
      if (res.status === 202) {
        await sleep(SERP_POLL_INTERVAL_MS);
        continue;
      }

      const errBody = await res.text().catch(() => '');
      throw new Error(`SERP get_result returned HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    } catch (err) {
      if (attempt === SERP_MAX_POLL_ATTEMPTS) throw err;
      console.warn(LOG_PREFIX, `SERP poll attempt ${attempt} failed:`, (err as Error).message);
      await sleep(SERP_POLL_INTERVAL_MS);
    }
  }

  throw new Error(`SERP result not ready after ${SERP_MAX_POLL_ATTEMPTS} attempts`);
}

export async function serpFindLinkedInUrl(
  query: string,
): Promise<string | null> {
  if (!query || !query.trim()) return null;

  // Build a Google search URL scoped to LinkedIn profiles
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in ' + query)}&hl=en&gl=us&num=5`;

  console.log(LOG_PREFIX, 'SERP LinkedIn search:', query);
  const start = Date.now();

  try {
    const data = await _serpRequest(searchUrl);
    const elapsed = Date.now() - start;
    const url = extractLinkedInUrl(data);
    console.log(LOG_PREFIX, `SERP LinkedIn search completed in ${elapsed}ms, found: ${url || 'none'}`);
    return url;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.warn(LOG_PREFIX, `SERP LinkedIn search failed in ${elapsed}ms:`, (err as Error).message);
    throw err;
  }
}

export async function serpSearchCompanyInfo(
  companyName: string,
): Promise<CompanyInfo | null> {
  if (!companyName || !companyName.trim()) return null;

  const query = `${companyName} company overview products services founded`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us&num=10`;

  console.log(LOG_PREFIX, 'SERP company search:', companyName);

  try {
    const data = await _serpRequest(searchUrl);
    return extractCompanyInfo(data, companyName);
  } catch (err) {
    console.warn(LOG_PREFIX, 'SERP company search failed:', (err as Error).message);
    return null;
  }
}

interface SerpSnippet {
  snippet: string;
  title: string;
  link: string;
}

function extractCompanyInfo(data: unknown, companyName: string): CompanyInfo | null {
  const result: CompanyInfo = {
    company_description: null,
    company_website: null,
    company_industry: null,
    company_founded_year: null,
    company_headquarters: null,
    products_services: null,
    company_funding: null,
    recent_news: null,
  };

  const snippets: SerpSnippet[] = [];
  const nameLower = companyName.toLowerCase();

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const organic = (d.organic || d.results || d.organic_results || []) as Array<Record<string, unknown>>;
    for (const r of organic) {
      const snippet = String(r?.snippet || r?.description || '');
      const title = String(r?.title || '');
      const link = String(r?.link || r?.url || '');
      if (snippet) snippets.push({ snippet, title, link });
    }

    const kg = d.knowledge_graph as Record<string, unknown> | undefined;
    if (kg) {
      if (kg.description) result.company_description = String(kg.description);
      if (kg.website) result.company_website = String(kg.website);
      if (kg.type) result.company_industry = String(kg.type);
      if (kg.founded) result.company_founded_year = String(kg.founded);
      if (kg.headquarters) result.company_headquarters = String(kg.headquarters);
    }
  }

  const text = typeof data === 'string' ? data : JSON.stringify(data);

  if (!result.company_founded_year) {
    const foundedMatch = text.match(/(?:founded|established|started)\s+(?:in\s+)?(\d{4})/i);
    if (foundedMatch) result.company_founded_year = foundedMatch[1];
  }

  if (!result.company_headquarters) {
    const hqMatch = text.match(/(?:headquartered|based|hq)\s+(?:in\s+)?([A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+)/i);
    if (hqMatch) result.company_headquarters = hqMatch[1].trim();
  }

  if (!result.company_description && snippets.length > 0) {
    const relevant = snippets
      .filter((s) => s.snippet.toLowerCase().includes(nameLower) || s.title.toLowerCase().includes(nameLower))
      .slice(0, 3);
    if (relevant.length > 0) {
      result.company_description = relevant.map((s) => s.snippet).join(' ').slice(0, 500);
    }
  }

  if (!result.company_website && snippets.length > 0) {
    const siteSnippet = snippets.find(
      (s) =>
        s.link && !s.link.includes('linkedin.com') && !s.link.includes('wikipedia.org') && s.title.toLowerCase().includes(nameLower),
    );
    if (siteSnippet) result.company_website = siteSnippet.link;
  }

  const fundingMatch = text.match(/(?:raised|funding|series [a-z])\s*[:\-]?\s*\$?([\d,.]+\s*(?:million|billion|m|b|M|B))/i);
  if (fundingMatch) result.company_funding = fundingMatch[0].trim();

  const newsSnippet = snippets.find((s) => /\d{4}|announced|launched|acquired|partnership|raised/i.test(s.snippet));
  if (newsSnippet) result.recent_news = newsSnippet.snippet.slice(0, 250);

  const populated = Object.values(result).filter(Boolean).length;
  console.log(LOG_PREFIX, `Company SERP extracted ${populated}/8 fields for "${companyName}"`);

  return populated > 0 ? result : null;
}
