// PreMeet — Company Data Enrichment Edge Function
// POST /api/enrichment-company
//
// Progressive enrichment with fallback chain:
//   Cache → MCP LinkedIn Company (~5s) → SERP → MCP Crunchbase → Deep Lookup
//
// Returns enriched company data with source and enrichmentLevel indicators.
//
// Request body:
//   { "companyName": string, "linkedinUrl?": string, "website?": string }

// Use Node.js runtime for longer timeout (60s) — needed for MCP SSE transport
export const config = { maxDuration: 60 };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { executeFallbackChain, type FallbackLayer, type EnrichmentLevel } from './_shared/fallback-chain';
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
    if (match) return `linkedin:${decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '')}`;
  }
  return `name:${req.companyName.toLowerCase().trim()}`;
}

function normalizeCompanyData(raw: Record<string, unknown>): CompanyData {
  const fundingInvestors: string[] = [];
  if (Array.isArray(raw.investors)) {
    for (const inv of raw.investors) {
      if (typeof inv === 'string') fundingInvestors.push(inv);
      else if (inv && typeof inv === 'object' && 'name' in inv) fundingInvestors.push(String(inv.name));
    }
  }

  const products: string[] = [];
  if (Array.isArray(raw.products)) {
    for (const p of raw.products) {
      if (typeof p === 'string') products.push(p);
      else if (p && typeof p === 'object' && 'name' in p) products.push(String(p.name));
    }
  }

  const technologies: string[] = [];
  const techSource = [raw.technologies, raw.techStack, raw.tech_stack].find(Array.isArray);
  if (techSource) {
    for (const t of techSource as unknown[]) {
      if (typeof t === 'string') technologies.push(t);
      else if (t && typeof t === 'object' && 'name' in (t as Record<string, unknown>)) technologies.push(String((t as Record<string, unknown>).name));
    }
  }

  const recentNews: Array<{ title: string; url: string; date: string }> = [];
  const newsSource = [raw.recent_news, raw.news].find(Array.isArray);
  if (newsSource) {
    for (const n of newsSource as Array<Record<string, unknown>>) {
      if (n && typeof n === 'object' && n.title) {
        recentNews.push({
          title: String(n.title),
          url: String(n.url || ''),
          date: String(n.date || n.published_at || ''),
        });
      }
    }
  }

  const intentSignals: Array<{ signal: string; detail: string }> = [];
  const signalSource = [raw.intent_signals, raw.signals, raw.intentTopics].find(Array.isArray);
  if (signalSource) {
    for (const s of signalSource as Array<Record<string, unknown> | string>) {
      if (typeof s === 'string') {
        intentSignals.push({ signal: s, detail: '' });
      } else if (s && typeof s === 'object' && (s.signal || s.type)) {
        intentSignals.push({
          signal: String(s.signal || s.type || ''),
          detail: String(s.detail || s.description || ''),
        });
      }
    }
  }

  return {
    name: String(raw.name || raw.company_name || ''),
    linkedinUrl: raw.linkedin_url ? String(raw.linkedin_url) : raw.url ? String(raw.url) : null,
    logo: raw.logo || raw.logo_url ? String(raw.logo || raw.logo_url) : null,
    industry: raw.industry ? String(raw.industry) : raw.industries ? String(Array.isArray(raw.industries) ? (raw.industries as string[])[0] : raw.industries) : null,
    sizeRange: raw.company_size ? String(raw.company_size) : raw.size_range ? String(raw.size_range) : raw.employee_count ? String(raw.employee_count) : null,
    revenueRange: raw.revenue_range ? String(raw.revenue_range) : raw.revenue ? String(raw.revenue) : null,
    website: raw.website ? String(raw.website) : null,
    foundedYear: raw.founded_year ? Number(raw.founded_year) : raw.founded ? Number(raw.founded) : null,
    hqAddress: raw.hq_address ? String(raw.hq_address) : raw.headquarters ? String(raw.headquarters) : null,
    description: raw.description ? String(raw.description) : raw.about ? String(raw.about) : null,
    fundingTotal: raw.funding_total ? String(raw.funding_total) : raw.total_funding ? String(raw.total_funding) : raw.totalFunding ? String(raw.totalFunding) : null,
    fundingLastRound: raw.funding_last_round ? String(raw.funding_last_round) : raw.last_funding_round ? String(raw.last_funding_round) : null,
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

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, cors, 405);
  }

  // Step 1: Authenticate
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.context;

  // Step 2: Parse and validate request
  let body: CompanyRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!body.companyName || typeof body.companyName !== 'string') {
    return jsonResponse({ error: 'Missing required field: companyName' }, cors, 400);
  }

  const entityKey = buildEntityKey(body);

  // Step 3: Check credits
  const userRows = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (userRows.length === 0) {
    return jsonResponse({ error: 'User not found' }, cors, 404);
  }

  const user = userRows[0];
  const currentMonth = new Date().toISOString().slice(0, 7);

  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth} WHERE id = ${userId}`;
    creditsUsed = 0;
  }

  if (user.subscription_tier === 'free' && creditsUsed >= user.credits_limit) {
    return jsonResponse({ error: 'Credit limit reached', creditsUsed, creditsLimit: user.credits_limit, tier: user.subscription_tier }, cors, 402);
  }

  // Step 4: Build and execute fallback chain
  const mcpToken = process.env.MCP_API_KEY;

  if (!mcpToken) {
    return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);
  }

  const companyUrl = body.linkedinUrl || `https://www.linkedin.com/company/${encodeURIComponent(body.companyName.toLowerCase().replace(/\s+/g, '-'))}`;

  const layers: FallbackLayer<CompanyData>[] = [
    // Layer 0: Neon cache (30-day TTL)
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

    // Layer 1: MCP LinkedIn Company Profile (~5s, 23 fields — fastest for companies)
    {
      name: 'mcp-linkedin-company',
      level: 'standard' as EnrichmentLevel,
      execute: async () => {
        if (!mcpToken) return null;
        const result = await callMcpTool(
          'web_data_linkedin_company_profile',
          { url: companyUrl },
          mcpToken,
          20_000,
        );
        if (!result.data) return null;
        return normalizeCompanyData(result.data);
      },
    },

    // NOTE: LinkedIn Profiles Dataset (gd_l1viktl72bvl7bjuj0) rejects /company/ URLs.
    // MCP Crunchbase (~56s) and Deep Lookup (~80s) exceed Vercel edge 25s timeout.
    // These will be available via separate async enrichment in a future release.
  ];

  const chainResult = await executeFallbackChain(layers, 'enrichment-company');

  if (!chainResult.data) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({
      error: 'No company data found',
      layerLog: chainResult.layerLog,
    }, cors, 404);
  }

  const isCacheHit = chainResult.source === 'cache';

  // Step 5: Cache result (skip if already from cache)
  if (!isCacheHit) {
    const enrichmentJson = JSON.stringify(chainResult.data);
    await sql`
      INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
      VALUES ('company', ${entityKey}, ${enrichmentJson}::jsonb, ${chainResult.source}, now() + make_interval(days => ${CACHE_TTL_DAYS}))
      ON CONFLICT (entity_type, entity_key)
      DO UPDATE SET
        enrichment_data = ${enrichmentJson}::jsonb,
        source = ${chainResult.source},
        fetched_at = now(),
        expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
    `;
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`.catch(() => {});
  } else {
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`.catch(() => {});
  }

  // Step 6: Deduct credit and log
  if (!isCacheHit) {
    await sql`UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}`;
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
