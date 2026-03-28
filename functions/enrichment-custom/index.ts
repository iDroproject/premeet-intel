// PreMeet — Custom Prompt-Based Deep Search Edge Function (Pro-only)
// POST /functions/v1/enrichment-custom
//
// Executes targeted SERP queries derived from a user prompt + person context
// via BrightData, then caches and returns structured results.
// Requires Pro subscription. Costs 2 credits per fresh fetch.
//
// Request body:
//   { "linkedinUrl": string, "fullName": string, "prompt": string }
//
// Returns: { results: Array<{ title, snippet, url, date? }>, summary: string }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';
import { sql } from '../_shared/db.ts';
import { fetchWithRetry } from '../_shared/fetch-retry.ts';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';
// BrightData SERP dataset for Google search results
const SERP_DATASET_ID = Deno.env.get('BRIGHTDATA_SERP_DATASET_ID') || 'gd_l1viktl72bvl7bjuj0';
const CACHE_TTL_DAYS = 7;
const CREDITS_PER_SEARCH = 2;
const MAX_PROMPT_LENGTH = 500;
const MAX_QUERIES = 3;

interface CustomSearchRequest {
  linkedinUrl: string;
  fullName: string;
  prompt: string;
}

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  date?: string;
}

/**
 * Build a deterministic cache key from person identity + prompt.
 * Uses a simple hash to keep the key short and consistent.
 */
async function buildEntityKey(linkedinUrl: string, prompt: string): Promise<string> {
  const normalizedPrompt = prompt.toLowerCase().trim();
  // Extract LinkedIn slug if possible
  const match = linkedinUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  const personKey = match
    ? decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '')
    : linkedinUrl.toLowerCase().trim();

  const raw = `${personKey}:${normalizedPrompt}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `custom:${hashHex.slice(0, 32)}`;
}

/**
 * Construct targeted SERP queries from a user prompt and person context.
 * Returns up to MAX_QUERIES search strings.
 */
function buildSearchQueries(fullName: string, prompt: string): string[] {
  const queries: string[] = [];

  // Primary query: person name + prompt directly
  queries.push(`"${fullName}" ${prompt}`);

  // Secondary query: without quotes for broader results
  if (prompt.split(/\s+/).length > 2) {
    queries.push(`${fullName} ${prompt}`);
  }

  // Tertiary query: prompt with site restrictions for authoritative sources
  queries.push(`${fullName} ${prompt} site:linkedin.com OR site:crunchbase.com OR site:bloomberg.com`);

  return queries.slice(0, MAX_QUERIES);
}

/**
 * Parse raw BrightData SERP response into structured results.
 */
function parseSerpResults(rawResults: Array<Record<string, unknown>>): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of rawResults) {
    // BrightData SERP returns organic results in various formats
    const organics: Array<Record<string, unknown>> = [];

    if (Array.isArray(item.organic)) {
      organics.push(...(item.organic as Array<Record<string, unknown>>));
    } else if (item.title && item.link) {
      // Single result format
      organics.push(item);
    }

    for (const result of organics) {
      const url = String(result.link || result.url || '');
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      results.push({
        title: String(result.title || ''),
        snippet: String(result.description || result.snippet || ''),
        url,
        ...(result.date ? { date: String(result.date) } : {}),
      });
    }
  }

  return results;
}

/**
 * Build a short summary from the top search results.
 */
function buildSummary(results: SearchResult[], prompt: string): string {
  if (results.length === 0) {
    return `No results found for: ${prompt}`;
  }

  const topSnippets = results
    .slice(0, 3)
    .map((r) => r.snippet)
    .filter((s) => s.length > 0);

  if (topSnippets.length === 0) {
    return `Found ${results.length} result(s) related to: ${prompt}`;
  }

  return topSnippets.join(' ... ').slice(0, 500);
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
  let body: CustomSearchRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.linkedinUrl || typeof body.linkedinUrl !== 'string') {
    return jsonResponse({ error: 'Missing required field: linkedinUrl' }, 400);
  }
  if (!body.fullName || typeof body.fullName !== 'string') {
    return jsonResponse({ error: 'Missing required field: fullName' }, 400);
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return jsonResponse({ error: 'Missing required field: prompt' }, 400);
  }
  if (body.prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` }, 400);
  }

  // Step 3: Verify Pro subscription
  const userRows = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (userRows.length === 0) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const user = userRows[0];

  if (user.subscription_tier === 'free') {
    return jsonResponse({
      error: 'Pro subscription required',
      message: 'Custom deep search is available on the Pro plan. Upgrade to access prompt-based research.',
      tier: user.subscription_tier,
    }, 403);
  }

  // Step 4: Check Neon cache (7-day TTL)
  const entityKey = await buildEntityKey(body.linkedinUrl, body.prompt);

  // NOTE: Using entity_type='person' with custom: key prefix.
  // PRE-98 will add 'custom_enrichment' to the entity_type enum.
  const cached = await sql`
    SELECT enrichment_data, fetched_at, expires_at
    FROM enrichment_cache
    WHERE entity_type = 'person'
      AND entity_key = ${entityKey}
      AND expires_at > now()
    LIMIT 1
  `;

  if (cached.length > 0) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'cached', true)
    `;

    await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 1, 0)`;

    return jsonResponse({
      data: cached[0].enrichment_data,
      cached: true,
      fetchedAt: cached[0].fetched_at,
    });
  }

  // Step 5: Check credits (custom search costs 2 credits)
  const currentMonth = new Date().toISOString().slice(0, 7);

  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`
      UPDATE users
      SET credits_used = 0, credits_reset_month = ${currentMonth}
      WHERE id = ${userId}
    `;
    creditsUsed = 0;
  }

  if (creditsUsed + CREDITS_PER_SEARCH > user.credits_limit) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsUsed,
      creditsLimit: user.credits_limit,
      creditsRequired: CREDITS_PER_SEARCH,
      tier: user.subscription_tier,
    }, 402);
  }

  // Step 6: Call BrightData SERP for targeted deep search
  const brightdataApiKey = Deno.env.get('BRIGHTDATA_API_KEY');
  if (!brightdataApiKey) {
    return jsonResponse({ error: 'Enrichment service not configured' }, 503);
  }

  const searchQueries = buildSearchQueries(body.fullName, body.prompt);
  const scrapeInputs = searchQueries.map((query) => ({ keyword: query }));

  const scrapePath = `/datasets/v3/scrape?dataset_id=${SERP_DATASET_ID}&notify=false&include_errors=true`;

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
        body: JSON.stringify({ input: scrapeInputs }),
      },
      'enrichment-custom',
    );
  } catch (err) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: `Upstream error: ${(err as Error).message}` }, 502);
  }

  if (!upstream.ok && upstream.status !== 202) {
    const errText = await upstream.text().catch(() => '');
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: `BrightData error: HTTP ${upstream.status}`, detail: errText.slice(0, 200) }, 502);
  }

  // Handle async (202) vs sync response
  if (upstream.status === 202) {
    const asyncBody = await upstream.json();
    const snapshotId = asyncBody?.snapshot_id;

    await sql`
      UPDATE users SET credits_used = credits_used + ${CREDITS_PER_SEARCH} WHERE id = ${userId}
    `;
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, ${CREDITS_PER_SEARCH}, 'pending', false)
    `;

    return jsonResponse({
      status: 'pending',
      snapshotId,
      message: 'Deep search is being processed. Poll the snapshot endpoint for results.',
    }, 202);
  }

  // Synchronous response — parse, cache, and return
  const rawData = await upstream.json();
  const rawResults: Array<Record<string, unknown>> = Array.isArray(rawData) ? rawData : [rawData];
  const valid = rawResults.filter((r) => !r.error && !r.error_code);

  if (valid.length === 0) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: 'No search results found' }, 404);
  }

  const results = parseSerpResults(valid);
  const summary = buildSummary(results, body.prompt);
  const responseData = { results, summary };
  const enrichmentJson = JSON.stringify(responseData);

  // Step 7: Cache result in Neon (7-day TTL)
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, 'brightdata_serp', now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      source = 'brightdata_serp',
      fetched_at = now(),
      expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;

  await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`;

  // Step 8: Deduct 2 credits and log request
  await sql`
    UPDATE users SET credits_used = credits_used + ${CREDITS_PER_SEARCH} WHERE id = ${userId}
  `;
  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'person', ${entityKey}, ${CREDITS_PER_SEARCH}, 'success', false, now())
  `;

  // Step 9: Log prompt for analytics (enrichment_prompts table pending PRE-98)
  // TODO(PRE-98): INSERT INTO enrichment_prompts (user_id, prompt, entity_key, ...) when table exists

  return jsonResponse({
    data: responseData,
    cached: false,
    fetchedAt: new Date().toISOString(),
  });
});
