// PreMeet — Custom Prompt-Based Deep Search Edge Function (Pro-only)
// POST /api/enrichment-custom
//
// Progressive enrichment with fallback chain:
//   Cache → SERP (fast) → MCP Social Media (LinkedIn posts, X posts, etc.) → Deep Lookup
//
// Request body:
//   { "linkedinUrl": string, "fullName": string, "prompt": string }
//
// Returns: { results: Array<{ title, snippet, url, date? }>, summary: string }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { fetchWithRetry } from './_shared/fetch-retry';
import { executeFallbackChain, type FallbackLayer, type EnrichmentLevel } from './_shared/fallback-chain';
import { callMcpTool } from './_shared/mcp-client';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';
const SERP_DATASET_ID = 'gd_l1viktl72bvl7bjuj0';
const CACHE_TTL_DAYS = 7;
const CREDITS_PER_SEARCH = 2;
const MAX_PROMPT_LENGTH = 500;
const MAX_QUERIES = 3;

// MCP social media tools available for custom search enrichment
const SOCIAL_MEDIA_TOOLS = [
  { tool: 'web_data_linkedin_posts', argKey: 'url', urlPrefix: 'linkedin.com' },
  { tool: 'web_data_x_posts', argKey: 'url', urlPrefix: 'x.com' },
  { tool: 'web_data_reddit_posts', argKey: 'url', urlPrefix: 'reddit.com' },
] as const;

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
  source?: string;
}

interface CustomSearchData {
  results: SearchResult[];
  summary: string;
}

async function buildEntityKey(linkedinUrl: string, prompt: string): Promise<string> {
  const normalizedPrompt = prompt.toLowerCase().trim();
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

function buildSearchQueries(fullName: string, prompt: string): string[] {
  const queries: string[] = [];
  queries.push(`"${fullName}" ${prompt}`);
  if (prompt.split(/\s+/).length > 2) {
    queries.push(`${fullName} ${prompt}`);
  }
  queries.push(`${fullName} ${prompt} site:linkedin.com OR site:crunchbase.com OR site:bloomberg.com`);
  return queries.slice(0, MAX_QUERIES);
}

function parseSerpResults(rawResults: Array<Record<string, unknown>>): SearchResult[] {
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of rawResults) {
    const organics: Array<Record<string, unknown>> = [];
    if (Array.isArray(item.organic)) {
      organics.push(...(item.organic as Array<Record<string, unknown>>));
    } else if (item.title && item.link) {
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
        source: 'serp',
      });
    }
  }

  return results;
}

function parseMcpSocialResults(data: Record<string, unknown>, toolName: string): SearchResult[] {
  const results: SearchResult[] = [];

  // MCP social media tools return arrays of posts/content
  const items = Array.isArray(data) ? data : data.posts ? (data.posts as unknown[]) : [data];

  for (const item of items as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title || item.text || item.content || '').slice(0, 200);
    const url = String(item.url || item.link || item.post_url || '');
    if (!title && !url) continue;

    results.push({
      title: title || `${toolName} post`,
      snippet: String(item.description || item.text || item.content || '').slice(0, 500),
      url,
      ...(item.date || item.published_at || item.created_at
        ? { date: String(item.date || item.published_at || item.created_at) }
        : {}),
      source: toolName,
    });
  }

  return results;
}

function buildSummary(results: SearchResult[], prompt: string): string {
  if (results.length === 0) return `No results found for: ${prompt}`;
  const topSnippets = results.slice(0, 3).map((r) => r.snippet).filter((s) => s.length > 0);
  if (topSnippets.length === 0) return `Found ${results.length} result(s) related to: ${prompt}`;
  return topSnippets.join(' ... ').slice(0, 500);
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

  let body: CustomSearchRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!body.linkedinUrl || typeof body.linkedinUrl !== 'string') return jsonResponse({ error: 'Missing required field: linkedinUrl' }, cors, 400);
  if (!body.fullName || typeof body.fullName !== 'string') return jsonResponse({ error: 'Missing required field: fullName' }, cors, 400);
  if (!body.prompt || typeof body.prompt !== 'string') return jsonResponse({ error: 'Missing required field: prompt' }, cors, 400);
  if (body.prompt.length > MAX_PROMPT_LENGTH) return jsonResponse({ error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` }, cors, 400);

  // Check Pro + credits
  const userRows = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  if (userRows.length === 0) return jsonResponse({ error: 'User not found' }, cors, 404);

  const user = userRows[0];
  if (user.subscription_tier === 'free') {
    return jsonResponse({ error: 'Pro subscription required', message: 'Custom deep search is available on the Pro plan.', tier: user.subscription_tier }, cors, 403);
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth} WHERE id = ${userId}`;
    creditsUsed = 0;
  }

  if (creditsUsed + CREDITS_PER_SEARCH > user.credits_limit) {
    return jsonResponse({ error: 'Credit limit reached', creditsUsed, creditsLimit: user.credits_limit, creditsRequired: CREDITS_PER_SEARCH, tier: user.subscription_tier }, cors, 402);
  }

  const entityKey = await buildEntityKey(body.linkedinUrl, body.prompt);
  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  const mcpToken = process.env.MCP_API_KEY;

  if (!brightdataApiKey) return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);

  // Build fallback chain for custom search
  const layers: FallbackLayer<CustomSearchData>[] = [
    // Layer 0: Cache
    {
      name: 'cache',
      level: 'cache' as EnrichmentLevel,
      execute: async () => {
        const cached = await sql`
          SELECT enrichment_data FROM enrichment_cache
          WHERE entity_type = 'person' AND entity_key = ${entityKey} AND expires_at > now()
          LIMIT 1
        `;
        return cached.length > 0 ? (cached[0].enrichment_data as CustomSearchData) : null;
      },
    },

    // Layer 1: SERP (fastest — Google search results)
    {
      name: 'serp',
      level: 'basic' as EnrichmentLevel,
      execute: async () => {
        const searchQueries = buildSearchQueries(body.fullName, body.prompt);
        const scrapeInputs = searchQueries.map((keyword) => ({ keyword }));
        const scrapePath = `/datasets/v3/scrape?dataset_id=${SERP_DATASET_ID}&notify=false&include_errors=true`;

        const upstream = await fetchWithRetry(
          `${BRIGHTDATA_BASE}${scrapePath}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${brightdataApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(scrapeInputs),
          },
          'custom-serp',
        );

        if (!upstream.ok) return null;
        const rawData = await upstream.json();
        const rawResults: Array<Record<string, unknown>> = Array.isArray(rawData) ? rawData : [rawData];
        const valid = rawResults.filter((r) => !r.error && !r.error_code);
        if (valid.length === 0) return null;

        const results = parseSerpResults(valid);
        if (results.length === 0) return null;
        return { results, summary: buildSummary(results, body.prompt) };
      },
    },

    // Layer 2: MCP Social Media (LinkedIn posts, X posts, Reddit)
    {
      name: 'mcp-social',
      level: 'standard' as EnrichmentLevel,
      execute: async () => {
        if (!mcpToken) return null;

        // Try LinkedIn posts first (most relevant for professional context)
        const linkedinResult = await callMcpTool(
          'web_data_linkedin_posts',
          { url: body.linkedinUrl },
          mcpToken,
          30_000,
        );

        if (linkedinResult.data) {
          const results = parseMcpSocialResults(linkedinResult.data, 'linkedin-posts');
          if (results.length > 0) {
            return { results, summary: buildSummary(results, body.prompt) };
          }
        }

        // Try X/Twitter posts if LinkedIn didn't return results
        const personSlug = body.fullName.toLowerCase().replace(/\s+/g, '');
        const xResult = await callMcpTool(
          'web_data_x_posts',
          { url: `https://x.com/${personSlug}` },
          mcpToken,
          30_000,
        );

        if (xResult.data) {
          const results = parseMcpSocialResults(xResult.data, 'x-posts');
          if (results.length > 0) {
            return { results, summary: buildSummary(results, body.prompt) };
          }
        }

        return null;
      },
    },

    // NOTE: Deep Lookup (~80s) exceeds Vercel edge 25s timeout.
    // Available via separate async enrichment in a future release.
  ];

  const chainResult = await executeFallbackChain(layers, 'enrichment-custom');

  if (!chainResult.data) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: 'No search results found', layerLog: chainResult.layerLog }, cors, 404);
  }

  const isCacheHit = chainResult.source === 'cache';

  if (!isCacheHit) {
    const enrichmentJson = JSON.stringify(chainResult.data);
    await sql`
      INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
      VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, ${chainResult.source}, now() + make_interval(days => ${CACHE_TTL_DAYS}))
      ON CONFLICT (entity_type, entity_key)
      DO UPDATE SET
        enrichment_data = ${enrichmentJson}::jsonb,
        source = ${chainResult.source},
        fetched_at = now(),
        expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
    `;
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`.catch(() => {});

    await sql`UPDATE users SET credits_used = credits_used + ${CREDITS_PER_SEARCH} WHERE id = ${userId}`;
  } else {
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 1, 0)`.catch(() => {});
  }

  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'person', ${entityKey}, ${isCacheHit ? 0 : CREDITS_PER_SEARCH}, 'success', ${isCacheHit}, now())
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
