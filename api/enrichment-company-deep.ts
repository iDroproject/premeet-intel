// PreMeet — Deep Company Enrichment (hybrid: Dataset Filter + Google AI Mode)
// POST /api/enrichment-company-deep
//
// Runs two data sources in parallel within the 25s edge timeout:
//   1. Dataset Filter (gd_m3fl0mwzmfpfn4cw4, 331 datapoints) by id_lc
//   2. Web Scraper Google AI Mode (gd_mcswdt6z2elth3zqr2) for products/description
//
// Returns merged CompanyData. Caller should already have a basic SERP profile
// from /api/enrichment-company and merge this deeper data on top.
//
// Request body:
//   { "companyName": string, "linkedinId": string, "linkedinUrl?": string, "website?": string }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { queryCompany } from './_shared/dataset-filter';

const CACHE_TTL_DAYS = 30;
const BRIGHTDATA_SCRAPE_URL = 'https://api.brightdata.com/datasets/v3/scrape';
const GOOGLE_AI_MODE_DATASET = 'gd_mcswdt6z2elth3zqr2';

// 20s timeout for each source — leaves headroom within 25s edge limit
const SOURCE_TIMEOUT_MS = 20_000;

interface DeepCompanyRequest {
  companyName: string;
  linkedinId: string;
  linkedinUrl?: string;
  website?: string;
}

interface CompanyData {
  name: string;
  linkedinUrl: string | null;
  linkedinId: string | null;
  logo: string | null;
  industry: string | null;
  sizeRange: string | null;
  revenueRange: string | null;
  website: string | null;
  foundedYear: number | null;
  hqAddress: string | null;
  description: string | null;
  fundingTotal: string | null;
  fundingLastRound: string | null;
  fundingInvestors: string[];
  products: string[];
  technologies: string[];
  recentNews: Array<{ title: string; url: string; date: string }>;
  intentSignals: Array<{ signal: string; detail: string }>;
  aiOverview: string | null;
}

function jsonResponse(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Dataset Filter normalizer ──────────────────────────────────────────────

function normalizeFilterData(raw: Record<string, unknown>, linkedinId: string): Partial<CompanyData> {
  const str = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = raw[k];
      if (v && typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'number') return String(v);
    }
    return null;
  };

  const arr = (keys: string[]): unknown[] => {
    for (const k of keys) {
      if (Array.isArray(raw[k]) && (raw[k] as unknown[]).length > 0) return raw[k] as unknown[];
    }
    return [];
  };

  const fundingInvestors: string[] = [];
  for (const inv of arr(['investors_cb', 'investors'])) {
    if (typeof inv === 'string') fundingInvestors.push(inv);
    else if (inv && typeof inv === 'object' && 'name' in (inv as Record<string, unknown>))
      fundingInvestors.push(String((inv as Record<string, unknown>).name));
  }

  const technologies: string[] = [];
  for (const t of arr(['technologies', 'tech_stack'])) {
    if (typeof t === 'string') technologies.push(t);
    else if (t && typeof t === 'object' && 'name' in (t as Record<string, unknown>))
      technologies.push(String((t as Record<string, unknown>).name));
  }

  const products: string[] = [];
  for (const p of arr(['products'])) {
    if (typeof p === 'string') products.push(p);
    else if (p && typeof p === 'object' && 'name' in (p as Record<string, unknown>))
      products.push(String((p as Record<string, unknown>).name));
  }

  const specialties = str(['specialties_lc', 'specialties']);
  if (specialties && products.length === 0) {
    products.push(...specialties.split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 10));
  }

  const recentNews: Array<{ title: string; url: string; date: string }> = [];
  for (const n of arr(['recent_news', 'news'])) {
    if (n && typeof n === 'object' && (n as Record<string, unknown>).title) {
      const nr = n as Record<string, unknown>;
      recentNews.push({ title: String(nr.title), url: String(nr.url || ''), date: String(nr.date || nr.published_at || '') });
    }
  }

  const intentSignals: Array<{ signal: string; detail: string }> = [];
  for (const s of arr(['intent_signals', 'signals'])) {
    if (typeof s === 'string') intentSignals.push({ signal: s, detail: '' });
    else if (s && typeof s === 'object') {
      const sr = s as Record<string, unknown>;
      if (sr.signal || sr.type) intentSignals.push({ signal: String(sr.signal || sr.type || ''), detail: String(sr.detail || sr.description || '') });
    }
  }

  return {
    name: str(['name_lc', 'name', 'company_name']) || undefined,
    linkedinUrl: str(['url_lc', 'linkedin_url', 'url']),
    linkedinId,
    logo: str(['logo_lc', 'logo', 'logo_url']),
    industry: str(['industry_lc', 'industry', 'industries_lc', 'industries']),
    sizeRange: str(['company_size_lc', 'company_size', 'size_range', 'employee_count']),
    revenueRange: str(['revenue_range_zi', 'revenue_range', 'revenue']),
    website: str(['website_lc', 'website', 'domain']),
    foundedYear: (() => { const v = str(['founded_lc', 'founded_year', 'founded']); return v ? Number(v) || null : null; })(),
    hqAddress: str(['headquarters_lc', 'hq_address', 'headquarters']),
    description: str(['about_lc', 'description', 'about']),
    fundingTotal: str(['total_funding_cb', 'funding_total', 'total_funding']),
    fundingLastRound: str(['last_funding_type_cb', 'funding_last_round']),
    fundingInvestors,
    products,
    technologies,
    recentNews,
    intentSignals,
  };
}

// ── Google AI Mode normalizer ──────────────────────────────────────────────

function normalizeAiModeData(raw: Record<string, unknown>): Partial<CompanyData> {
  // The Web Scraper returns the AI-generated response as text content
  const content = String(raw.content || raw.text || raw.response || raw.ai_response || '');
  if (!content) return {};

  // Extract products from the AI overview if mentioned
  const products: string[] = [];
  const prodMatch = content.match(/products?[:\s]+([^.]+)/i);
  if (prodMatch) {
    products.push(...prodMatch[1].split(/[,;]/).map((s: string) => s.trim()).filter(Boolean).slice(0, 10));
  }

  return {
    aiOverview: content.slice(0, 2000),
    ...(products.length > 0 ? { products } : {}),
    // Extract description if AI mode provides a good summary
    ...(!content.includes('not found') ? { description: content.slice(0, 500) } : {}),
  };
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, cors, 405);

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.context;

  let body: DeepCompanyRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, cors, 400); }
  if (!body.companyName || typeof body.companyName !== 'string') return jsonResponse({ error: 'Missing: companyName' }, cors, 400);
  if (!body.linkedinId || typeof body.linkedinId !== 'string') return jsonResponse({ error: 'Missing: linkedinId' }, cors, 400);

  const entityKey = `company-deep:${body.linkedinId.toLowerCase()}`;
  const start = performance.now();

  // Check cache first
  const cached = await sql`
    SELECT enrichment_data FROM enrichment_cache
    WHERE entity_type = 'company' AND entity_key = ${entityKey} AND expires_at > now()
    LIMIT 1
  `;
  if (cached.length > 0) {
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`.catch(() => {});
    return jsonResponse({
      data: cached[0].enrichment_data,
      source: 'cache',
      cached: true,
      fetchedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
    }, cors);
  }

  // Credits check
  const userRows = await sql`SELECT credits_used, credits_limit, credits_reset_month, subscription_tier FROM users WHERE id = ${userId} LIMIT 1`;
  if (userRows.length === 0) return jsonResponse({ error: 'User not found' }, cors, 404);
  const user = userRows[0];
  const currentMonth = new Date().toISOString().slice(0, 7);
  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth} WHERE id = ${userId}`;
    creditsUsed = 0;
  }
  if (user.subscription_tier === 'free' && creditsUsed >= user.credits_limit) {
    return jsonResponse({ error: 'Credit limit reached', creditsUsed, creditsLimit: user.credits_limit }, cors, 402);
  }

  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  if (!brightdataApiKey) return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);

  // Run both sources in parallel
  const sourceLog: Array<{ source: string; status: string; latencyMs: number; fields?: number }> = [];

  const filterPromise = withTimeout(
    queryCompany(body.linkedinId, brightdataApiKey, SOURCE_TIMEOUT_MS),
    SOURCE_TIMEOUT_MS,
    'dataset-filter',
  ).then((result) => {
    sourceLog.push({ source: 'dataset-filter', status: result.data ? 'ok' : 'empty', latencyMs: result.latencyMs, fields: result.fields });
    return result.data ? normalizeFilterData(result.data, body.linkedinId) : null;
  }).catch((err) => {
    sourceLog.push({ source: 'dataset-filter', status: 'error', latencyMs: Math.round(performance.now() - start) });
    console.warn('[enrichment-company-deep] Dataset Filter error:', (err as Error).message);
    return null;
  });

  const aiModePromise = withTimeout(
    (async () => {
      const scrapeResp = await fetch(
        `${BRIGHTDATA_SCRAPE_URL}?dataset_id=${GOOGLE_AI_MODE_DATASET}&notify=false&include_errors=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${brightdataApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: [{
              url: 'https://google.com/aimode',
              prompt: `${body.companyName} company overview, products, services, recent news, and key technologies`,
              country: '',
            }],
          }),
        },
      );

      if (!scrapeResp.ok) {
        const errText = await scrapeResp.text().catch(() => '');
        throw new Error(`AI Mode HTTP ${scrapeResp.status}: ${errText.slice(0, 200)}`);
      }

      const scrapeData = await scrapeResp.json();
      // WSA v3 scrape returns array of results
      const record = Array.isArray(scrapeData) ? scrapeData[0] : scrapeData;
      return record;
    })(),
    SOURCE_TIMEOUT_MS,
    'google-ai-mode',
  ).then((raw) => {
    if (!raw) return null;
    sourceLog.push({ source: 'google-ai-mode', status: 'ok', latencyMs: Math.round(performance.now() - start) });
    return normalizeAiModeData(raw as Record<string, unknown>);
  }).catch((err) => {
    sourceLog.push({ source: 'google-ai-mode', status: 'error', latencyMs: Math.round(performance.now() - start) });
    console.warn('[enrichment-company-deep] Google AI Mode error:', (err as Error).message);
    return null;
  });

  const [filterData, aiData] = await Promise.all([filterPromise, aiModePromise]);

  if (!filterData && !aiData) {
    return jsonResponse({ error: 'No deep company data found', sourceLog }, cors, 404);
  }

  // Merge: Dataset Filter is the primary source, AI Mode fills gaps
  const merged: CompanyData = {
    name: filterData?.name || body.companyName,
    linkedinUrl: filterData?.linkedinUrl || body.linkedinUrl || null,
    linkedinId: body.linkedinId,
    logo: filterData?.logo || null,
    industry: filterData?.industry || null,
    sizeRange: filterData?.sizeRange || null,
    revenueRange: filterData?.revenueRange || null,
    website: filterData?.website || body.website || null,
    foundedYear: filterData?.foundedYear || null,
    hqAddress: filterData?.hqAddress || null,
    description: filterData?.description || aiData?.description || null,
    fundingTotal: filterData?.fundingTotal || null,
    fundingLastRound: filterData?.fundingLastRound || null,
    fundingInvestors: filterData?.fundingInvestors || [],
    products: (filterData?.products?.length ? filterData.products : aiData?.products) || [],
    technologies: filterData?.technologies || [],
    recentNews: filterData?.recentNews || [],
    intentSignals: filterData?.intentSignals || [],
    aiOverview: aiData?.aiOverview || null,
  };

  // Cache the merged result
  const enrichmentJson = JSON.stringify(merged);
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('company', ${entityKey}, ${enrichmentJson}::jsonb, 'deep', now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET enrichment_data = ${enrichmentJson}::jsonb, source = 'deep', fetched_at = now(), expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;
  sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`.catch(() => {});
  await sql`UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}`;

  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'company', ${entityKey}, 1, 'success', false, now())
  `;

  return jsonResponse({
    data: merged,
    source: 'deep',
    enrichmentLevel: 'deep',
    cached: false,
    fetchedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - start),
    sourceLog,
  }, cors);
}
