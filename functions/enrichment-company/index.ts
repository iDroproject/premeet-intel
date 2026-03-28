// PreMeet — Company Data Enrichment Edge Function
// POST /functions/v1/enrichment-company
//
// Proxies company data requests to BrightData's LinkedIn company dataset,
// with Neon-backed caching (30-day TTL) and per-request credit deduction.
//
// Request body:
//   { "companyName": string, "linkedinUrl?": string, "website?": string }
//
// Returns: CompanyData JSON

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';
import { sql } from '../_shared/db.ts';
import { fetchWithRetry } from '../_shared/fetch-retry.ts';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';
const COMPANY_DATASET_ID = Deno.env.get('BRIGHTDATA_COMPANY_DATASET_ID') || 'gd_l1viktl72bvl7bjv0';
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
  // Prefer LinkedIn URL as the canonical key, fall back to normalized company name
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
  if (Array.isArray(raw.technologies)) {
    for (const t of raw.technologies) {
      if (typeof t === 'string') technologies.push(t);
      else if (t && typeof t === 'object' && 'name' in t) technologies.push(String(t.name));
    }
  }

  const recentNews: Array<{ title: string; url: string; date: string }> = [];
  if (Array.isArray(raw.recent_news || raw.news)) {
    for (const n of (raw.recent_news || raw.news) as Array<Record<string, unknown>>) {
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
  if (Array.isArray(raw.intent_signals || raw.signals)) {
    for (const s of (raw.intent_signals || raw.signals) as Array<Record<string, unknown>>) {
      if (s && typeof s === 'object' && s.signal) {
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
    industry: raw.industry ? String(raw.industry) : null,
    sizeRange: raw.company_size ? String(raw.company_size) : raw.size_range ? String(raw.size_range) : null,
    revenueRange: raw.revenue_range ? String(raw.revenue_range) : raw.revenue ? String(raw.revenue) : null,
    website: raw.website ? String(raw.website) : null,
    foundedYear: raw.founded_year ? Number(raw.founded_year) : raw.founded ? Number(raw.founded) : null,
    hqAddress: raw.hq_address ? String(raw.hq_address) : raw.headquarters ? String(raw.headquarters) : null,
    description: raw.description ? String(raw.description) : raw.about ? String(raw.about) : null,
    fundingTotal: raw.funding_total ? String(raw.funding_total) : raw.total_funding ? String(raw.total_funding) : null,
    fundingLastRound: raw.funding_last_round ? String(raw.funding_last_round) : raw.last_funding_round ? String(raw.last_funding_round) : null,
    fundingInvestors,
    products,
    technologies,
    recentNews,
    intentSignals,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
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
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.companyName || typeof body.companyName !== 'string') {
    return jsonResponse({ error: 'Missing required field: companyName' }, 400);
  }

  const entityKey = buildEntityKey(body);

  // Step 3: Check Neon cache (30-day TTL)
  const cached = await sql`
    SELECT enrichment_data, fetched_at, expires_at
    FROM enrichment_cache
    WHERE entity_type = 'company'
      AND entity_key = ${entityKey}
      AND expires_at > now()
    LIMIT 1
  `;

  if (cached.length > 0) {
    // Log cache hit (no credit deducted)
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 0, 'cached', true)
    `;

    // Update cache stats
    await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`;

    return jsonResponse({
      data: cached[0].enrichment_data,
      cached: true,
      fetchedAt: cached[0].fetched_at,
    });
  }

  // Step 4: Check credits
  const userRows = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (userRows.length === 0) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const user = userRows[0];
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Reset credits if new month
  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`
      UPDATE users
      SET credits_used = 0, credits_reset_month = ${currentMonth}
      WHERE id = ${userId}
    `;
    creditsUsed = 0;
  }

  // Pro users have unlimited credits; free users check limit
  if (user.subscription_tier === 'free' && creditsUsed >= user.credits_limit) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsUsed,
      creditsLimit: user.credits_limit,
      tier: user.subscription_tier,
    }, 402);
  }

  // Step 5: Call BrightData company endpoint
  const brightdataApiKey = Deno.env.get('BRIGHTDATA_API_KEY');
  if (!brightdataApiKey) {
    return jsonResponse({ error: 'Enrichment service not configured' }, 503);
  }

  // Build the scrape input based on available identifiers
  const scrapeInput: Record<string, string> = {};
  if (body.linkedinUrl) {
    scrapeInput.url = body.linkedinUrl;
  } else {
    scrapeInput.company_name = body.companyName;
    if (body.website) scrapeInput.website = body.website;
  }

  const scrapePath = `/datasets/v3/scrape?dataset_id=${COMPANY_DATASET_ID}&notify=false&include_errors=true`;

  let upstream: Response;
  try {
    upstream = await fetchWithRetry(
      `${BRIGHTDATA_BASE}${scrapePath}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${brightdataApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: [scrapeInput] }),
      },
      'enrichment-company',
    );
  } catch (err) {
    // Log failed request (all retries exhausted)
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: `Upstream error: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok && upstream.status !== 202) {
    const errText = await upstream.text().catch(() => '');
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: `BrightData error: HTTP ${upstream.status}`, detail: errText.slice(0, 200) }, 502);
  }

  // Handle async (202) vs sync response
  if (upstream.status === 202) {
    const asyncBody = await upstream.json();
    const snapshotId = asyncBody?.snapshot_id;

    // Log pending request (deduct credit now — will be fulfilled async)
    await sql`
      UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}
    `;
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 1, 'pending', false)
    `;

    return jsonResponse({
      status: 'pending',
      snapshotId,
      message: 'Company data is being fetched. Poll the snapshot endpoint for results.',
    }, 202);
  }

  // Synchronous response — parse and cache
  const rawData = await upstream.json();
  const profiles: Array<Record<string, unknown>> = Array.isArray(rawData) ? rawData : [rawData];
  const valid = profiles.filter((p) => !p.error && !p.error_code);

  if (valid.length === 0) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'company', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: 'No company data found' }, 404);
  }

  const companyData = normalizeCompanyData(valid[0]);
  const enrichmentJson = JSON.stringify(companyData);

  // Step 6: Cache result in Neon (30-day TTL)
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('company', ${entityKey}, ${enrichmentJson}::jsonb, 'brightdata', now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      source = 'brightdata',
      fetched_at = now(),
      expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;

  // Update cache stats
  await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`;

  // Step 7: Deduct 1 credit and log request
  await sql`
    UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}
  `;
  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'company', ${entityKey}, 1, 'success', false, now())
  `;

  return jsonResponse({
    data: companyData,
    cached: false,
    fetchedAt: new Date().toISOString(),
  });
});
