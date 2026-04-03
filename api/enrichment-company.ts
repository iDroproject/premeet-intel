// PreMeet — Company Data Enrichment
// POST /api/enrichment-company
//
// Correct API flow:
//   Cache → SERP (discover LinkedIn URL/ID, ~2s) → Dataset Filter by id_lc
//   (gd_m3fl0mwzmfpfn4cw4, 331 datapoints) → MCP LinkedIn Company (fallback)
//
// Request body:
//   { "companyName": string, "linkedinUrl?": string, "website?": string }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { executeFallbackChain, type FallbackLayer, type EnrichmentLevel } from './_shared/fallback-chain';
import { serpDiscoverCompany } from './_shared/serp-api';
import { queryCompany } from './_shared/dataset-filter';
import { callMcpTool } from './_shared/mcp-client';

const CACHE_TTL_DAYS = 30;

interface CompanyRequest {
  companyName: string;
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
}

function buildEntityKey(req: CompanyRequest): string {
  if (req.linkedinUrl) {
    const match = req.linkedinUrl.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
    if (match) return `company:${decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '').split('?')[0]}`;
  }
  return `company:name:${req.companyName.toLowerCase().trim()}`;
}

/**
 * Normalize company data from any source (Dataset Filter with _lc/_cb/_zi suffixed fields,
 * MCP with plain fields, or SERP with organic results).
 */
function normalizeCompanyData(raw: Record<string, unknown>, linkedinId?: string | null): CompanyData {
  // Dataset Filter fields use _lc (LinkedIn), _cb (Crunchbase), _zi (ZoomInfo) suffixes
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
  for (const inv of arr(['investors_cb', 'investors', 'fundingInvestors'])) {
    if (typeof inv === 'string') fundingInvestors.push(inv);
    else if (inv && typeof inv === 'object' && 'name' in (inv as Record<string, unknown>)) fundingInvestors.push(String((inv as Record<string, unknown>).name));
  }

  const technologies: string[] = [];
  for (const t of arr(['technologies', 'techStack', 'tech_stack'])) {
    if (typeof t === 'string') technologies.push(t);
    else if (t && typeof t === 'object' && 'name' in (t as Record<string, unknown>)) technologies.push(String((t as Record<string, unknown>).name));
  }

  const products: string[] = [];
  for (const p of arr(['products'])) {
    if (typeof p === 'string') products.push(p);
    else if (p && typeof p === 'object' && 'name' in (p as Record<string, unknown>)) products.push(String((p as Record<string, unknown>).name));
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
  for (const s of arr(['intent_signals', 'signals', 'intentTopics'])) {
    if (typeof s === 'string') intentSignals.push({ signal: s, detail: '' });
    else if (s && typeof s === 'object') {
      const sr = s as Record<string, unknown>;
      if (sr.signal || sr.type) intentSignals.push({ signal: String(sr.signal || sr.type || ''), detail: String(sr.detail || sr.description || '') });
    }
  }

  return {
    name: str(['name_lc', 'name', 'company_name']) || '',
    linkedinUrl: str(['url_lc', 'linkedin_url', 'url', 'company_linkedin_url']),
    linkedinId: linkedinId || str(['id_lc', 'company_id']) || null,
    logo: str(['logo_lc', 'logo', 'logo_url', 'company_logo']),
    industry: str(['industry_lc', 'industry', 'industries_lc', 'industries', 'company_categories']),
    sizeRange: str(['company_size_lc', 'company_size', 'size_range', 'employee_count']),
    revenueRange: str(['revenue_range_zi', 'revenue_range', 'revenue', 'company_revenue_usd']),
    website: str(['website_lc', 'website', 'company_website', 'domain']),
    foundedYear: (() => { const v = str(['founded_lc', 'founded_year', 'founded', 'company_founded_year']); return v ? Number(v) || null : null; })(),
    hqAddress: str(['headquarters_lc', 'hq_address', 'headquarters', 'company_headquarters']),
    description: str(['about_lc', 'description', 'about', 'company_description']),
    fundingTotal: str(['total_funding_cb', 'funding_total', 'total_funding', 'totalFunding']),
    fundingLastRound: str(['last_funding_type_cb', 'funding_last_round', 'last_funding_round']),
    fundingInvestors,
    products,
    technologies,
    recentNews,
    intentSignals,
  };
}

function jsonResponse(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, cors, 405);

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.context;

  let body: CompanyRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, cors, 400); }
  if (!body.companyName || typeof body.companyName !== 'string') return jsonResponse({ error: 'Missing required field: companyName' }, cors, 400);

  const entityKey = buildEntityKey(body);

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
  const mcpToken = process.env.MCP_API_KEY;
  if (!brightdataApiKey) return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);

  // Track the LinkedIn company ID discovered by SERP for use in Dataset Filter
  let discoveredLinkedinId: string | null = null;
  let discoveredLinkedinUrl: string | null = body.linkedinUrl || null;

  const layers: FallbackLayer<CompanyData>[] = [
    // Layer 0: Neon cache
    {
      name: 'cache',
      level: 'cache' as EnrichmentLevel,
      execute: async () => {
        const cached = await sql`
          SELECT enrichment_data FROM enrichment_cache
          WHERE entity_type = 'company' AND entity_key = ${entityKey} AND expires_at > now()
          LIMIT 1
        `;
        return cached.length > 0 ? (cached[0].enrichment_data as CompanyData) : null;
      },
    },

    // Layer 1: SERP discovery (~2s) — find LinkedIn company URL/ID
    {
      name: 'serp-discovery',
      level: 'basic' as EnrichmentLevel,
      execute: async () => {
        // Only run SERP if we don't have a LinkedIn URL yet
        if (!discoveredLinkedinId) {
          if (body.linkedinUrl) {
            // Extract ID from provided URL
            const match = body.linkedinUrl.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
            if (match) {
              discoveredLinkedinId = decodeURIComponent(match[1]).replace(/\/+$/, '').split('?')[0];
              discoveredLinkedinUrl = body.linkedinUrl;
            }
          }

          if (!discoveredLinkedinId) {
            const serp = await serpDiscoverCompany(body.companyName, brightdataApiKey);
            if (serp.companyLinkedinId) {
              discoveredLinkedinId = serp.companyLinkedinId;
              discoveredLinkedinUrl = serp.companyLinkedinUrl;
              console.log(`[enrichment-company] SERP found: ${discoveredLinkedinId} (${serp.latencyMs}ms)`);
            } else {
              console.log(`[enrichment-company] SERP: no company found`);
              return null;
            }
          }
        }
        // SERP alone doesn't return company data — fall through to next layer
        return null;
      },
    },

    // Layer 2: Return SERP discovery data as basic company profile
    // SERP results include the LinkedIn URL, company name from title, and ZoomInfo/RocketReach links.
    // This gives the client enough to display a card and trigger deeper enrichment.
    {
      name: 'serp-basic-profile',
      level: 'basic' as EnrichmentLevel,
      execute: async () => {
        if (!discoveredLinkedinId) return null;
        // Build a basic company profile from SERP discovery
        return {
          name: body.companyName,
          linkedinUrl: discoveredLinkedinUrl,
          linkedinId: discoveredLinkedinId,
          logo: null,
          industry: null,
          sizeRange: null,
          revenueRange: null,
          website: body.website || null,
          foundedYear: null,
          hqAddress: null,
          description: null,
          fundingTotal: null,
          fundingLastRound: null,
          fundingInvestors: [],
          products: [],
          technologies: [],
          recentNews: [],
          intentSignals: [],
        } satisfies CompanyData;
      },
    },

    // NOTE: For deep company enrichment (331 datapoints), the client should use
    // enrichment-proxy to call Dataset Filter or MCP directly. These APIs exceed
    // the 25s Vercel Hobby edge timeout. Upgrade to Pro for 60s+ maxDuration.
  ];

  const chainResult = await executeFallbackChain(layers, 'enrichment-company');

  if (!chainResult.data) {
    await sql`INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit) VALUES (${userId}, 'company', ${entityKey}, 0, 'failed', false)`;
    return jsonResponse({ error: 'No company data found', layerLog: chainResult.layerLog }, cors, 404);
  }

  const isCacheHit = chainResult.source === 'cache';

  if (!isCacheHit) {
    const enrichmentJson = JSON.stringify(chainResult.data);
    await sql`
      INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
      VALUES ('company', ${entityKey}, ${enrichmentJson}::jsonb, ${chainResult.source}, now() + make_interval(days => ${CACHE_TTL_DAYS}))
      ON CONFLICT (entity_type, entity_key)
      DO UPDATE SET enrichment_data = ${enrichmentJson}::jsonb, source = ${chainResult.source}, fetched_at = now(), expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
    `;
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`.catch(() => {});
    await sql`UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}`;
  } else {
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`.catch(() => {});
  }

  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'company', ${entityKey}, ${isCacheHit ? 0 : 1}, 'success', ${isCacheHit}, now())
  `;

  return jsonResponse({
    data: chainResult.data,
    source: chainResult.source,
    enrichmentLevel: chainResult.level,
    cached: isCacheHit,
    fetchedAt: new Date().toISOString(),
    latencyMs: chainResult.latencyMs,
  }, cors);
}
