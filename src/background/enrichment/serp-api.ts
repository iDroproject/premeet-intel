// PreMeet – SERP API Client (Discover endpoint)
// Uses the /discover endpoint for structured search results.
// Returns JSON with organic results for reliable LinkedIn URL extraction.

import { proxyFetch } from './brightdata-proxy';
import type { CompanyInfo } from './types';

const LOG_PREFIX = '[PreMeet][SERP]';

function extractLinkedInUrl(data: unknown): string | null {
  // 1. Structured JSON with organic results (brd_json=1 format).
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

  // 3. Fallback: regex scan the stringified response.
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const match = text.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
  if (match) {
    console.log(LOG_PREFIX, 'Found LinkedIn URL via regex:', match[0]);
    return match[0].split('?')[0].replace(/\/\/[a-z]{2,3}\.linkedin/, '//www.linkedin');
  }

  return null;
}

/**
 * Search via the /discover endpoint.
 * Accepts a plain-text query and returns structured JSON results.
 */
async function _discoverRequest(query: string): Promise<unknown> {
  console.log(LOG_PREFIX, 'Discover request:', query.slice(0, 120));

  const response = await proxyFetch('/discover', 'POST', {
    query,
    language: 'en',
    country: 'US',
    format: 'json',
    remove_duplicates: false,
    include_content: false,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Discover API HTTP ${response.status}: ${errBody.slice(0, 200)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function serpFindLinkedInUrl(
  query: string,
): Promise<string | null> {
  if (!query || !query.trim()) return null;

  // Use the Discover API with a linkedin-scoped query
  const discoverQuery = `${query} linkedin`;

  console.log(LOG_PREFIX, 'Discover LinkedIn search:', query);
  const start = Date.now();

  try {
    const data = await _discoverRequest(discoverQuery);
    const elapsed = Date.now() - start;
    const url = extractLinkedInUrl(data);
    console.log(LOG_PREFIX, `Discover LinkedIn search completed in ${elapsed}ms, found: ${url || 'none'}`);
    return url;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.warn(LOG_PREFIX, `Discover LinkedIn search failed in ${elapsed}ms:`, (err as Error).message);
    throw err;
  }
}

export async function serpSearchCompanyInfo(
  companyName: string,
): Promise<CompanyInfo | null> {
  if (!companyName || !companyName.trim()) return null;

  const discoverQuery = `${companyName} company overview products services founded`;

  console.log(LOG_PREFIX, 'Discover company search:', companyName);

  try {
    const data = await _discoverRequest(discoverQuery);
    return extractCompanyInfo(data, companyName);
  } catch (err) {
    console.warn(LOG_PREFIX, 'Discover company search failed:', (err as Error).message);
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
