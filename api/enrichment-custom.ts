// PreMeet — Custom Prompt-Based Deep Search (Pro-only)
// POST /api/enrichment-custom
//
// Correct API flow:
//   Cache → SERP (fast Google search, ~2s) → MCP social media (LinkedIn posts, X, Reddit)
//   → Discover API (deeper SERP with reranking + intent)
//
// Request body:
//   { "linkedinUrl": string, "fullName": string, "prompt": string }
//
// Returns: { results: Array<{ title, snippet, url, source }>, summary: string }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { executeFallbackChain, type FallbackLayer, type EnrichmentLevel } from './_shared/fallback-chain';
import { callMcpTool } from './_shared/mcp-client';

const CACHE_TTL_DAYS = 7;
const CREDITS_PER_SEARCH = 2;
const MAX_PROMPT_LENGTH = 500;
const BRIGHTDATA_BASE = 'https://api.brightdata.com';

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
  source: string;
}

interface CustomSearchData {
  results: SearchResult[];
  summary: string;
}

async function buildEntityKey(linkedinUrl: string, prompt: string): Promise<string> {
  const normalizedPrompt = prompt.toLowerCase().trim();
  const match = linkedinUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  const personKey = match ? decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '') : linkedinUrl.toLowerCase().trim();
  const raw = `${personKey}:${normalizedPrompt}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(raw));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return `custom:${hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
}

function buildSummary(results: SearchResult[], prompt: string): string {
  if (results.length === 0) return `No results found for: ${prompt}`;
  const topSnippets = results.slice(0, 3).map((r) => r.snippet).filter((s) => s.length > 0);
  if (topSnippets.length === 0) return `Found ${results.length} result(s) related to: ${prompt}`;
  return topSnippets.join(' ... ').slice(0, 500);
}

function jsonResponse(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, cors, 405);

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.context;

  let body: CustomSearchRequest;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, cors, 400); }
  if (!body.linkedinUrl || typeof body.linkedinUrl !== 'string') return jsonResponse({ error: 'Missing: linkedinUrl' }, cors, 400);
  if (!body.fullName || typeof body.fullName !== 'string') return jsonResponse({ error: 'Missing: fullName' }, cors, 400);
  if (!body.prompt || typeof body.prompt !== 'string') return jsonResponse({ error: 'Missing: prompt' }, cors, 400);
  if (body.prompt.length > MAX_PROMPT_LENGTH) return jsonResponse({ error: `Prompt exceeds ${MAX_PROMPT_LENGTH} chars` }, cors, 400);

  // Pro check + credits
  const userRows = await sql`SELECT credits_used, credits_limit, credits_reset_month, subscription_tier FROM users WHERE id = ${userId} LIMIT 1`;
  if (userRows.length === 0) return jsonResponse({ error: 'User not found' }, cors, 404);
  const user = userRows[0];
  if (user.subscription_tier === 'free') return jsonResponse({ error: 'Pro subscription required' }, cors, 403);
  const currentMonth = new Date().toISOString().slice(0, 7);
  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth} WHERE id = ${userId}`;
    creditsUsed = 0;
  }
  if (creditsUsed + CREDITS_PER_SEARCH > user.credits_limit) {
    return jsonResponse({ error: 'Credit limit reached', creditsUsed, creditsRequired: CREDITS_PER_SEARCH }, cors, 402);
  }

  const entityKey = await buildEntityKey(body.linkedinUrl, body.prompt);
  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  const mcpToken = process.env.MCP_API_KEY;
  if (!brightdataApiKey) return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);

  const layers: FallbackLayer<CustomSearchData>[] = [
    // Layer 0: Cache
    {
      name: 'cache',
      level: 'cache' as EnrichmentLevel,
      execute: async () => {
        const cached = await sql`
          SELECT enrichment_data FROM enrichment_cache
          WHERE entity_type = 'person' AND entity_key = ${entityKey} AND expires_at > now() LIMIT 1
        `;
        return cached.length > 0 ? (cached[0].enrichment_data as CustomSearchData) : null;
      },
    },

    // Layer 1: SERP API (fastest — ~2s, Google search results)
    {
      name: 'serp',
      level: 'basic' as EnrichmentLevel,
      execute: async () => {
        const query = `"${body.fullName}" ${body.prompt}`;
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

        const resp = await fetch(`${BRIGHTDATA_BASE}/request`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${brightdataApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone: 'serp', url, format: 'json', data_format: 'parsed_light' }),
        });
        if (!resp.ok) return null;

        const wrapper = await resp.json();
        const serpBody = typeof wrapper.body === 'string' ? JSON.parse(wrapper.body) : wrapper.body || wrapper;
        const organic: Array<Record<string, unknown>> = serpBody.organic || [];
        if (organic.length === 0) return null;

        const results: SearchResult[] = organic.slice(0, 10).map((r) => ({
          title: String(r.title || ''),
          snippet: String(r.description || ''),
          url: String(r.link || ''),
          ...(r.date ? { date: String(r.date) } : {}),
          source: 'serp',
        })).filter((r) => r.url);

        if (results.length === 0) return null;
        return { results, summary: buildSummary(results, body.prompt) };
      },
    },

    // Layer 2: MCP Social Media (LinkedIn posts — most relevant for professional context)
    {
      name: 'mcp-social',
      level: 'standard' as EnrichmentLevel,
      execute: async () => {
        if (!mcpToken) return null;

        const linkedinResult = await callMcpTool(
          'web_data_linkedin_posts',
          { url: body.linkedinUrl },
          mcpToken,
          20_000,
        );

        if (linkedinResult.data) {
          const posts = Array.isArray(linkedinResult.data) ? linkedinResult.data : [linkedinResult.data];
          const results: SearchResult[] = (posts as Array<Record<string, unknown>>)
            .filter((p) => p.text || p.content || p.title)
            .slice(0, 10)
            .map((p) => ({
              title: String(p.title || `${body.fullName} — LinkedIn post`),
              snippet: String(p.text || p.content || '').slice(0, 500),
              url: String(p.url || p.post_url || body.linkedinUrl),
              ...(p.date || p.published_at ? { date: String(p.date || p.published_at) } : {}),
              source: 'linkedin-posts',
            }));

          if (results.length > 0) {
            return { results, summary: buildSummary(results, body.prompt) };
          }
        }

        return null;
      },
    },

    // Layer 3: Discover API (deeper SERP with reranking + intent, ~30-70s)
    {
      name: 'discover-api',
      level: 'deep' as EnrichmentLevel,
      execute: async () => {
        const query = `intitle:"${body.fullName}" ${body.prompt}`;

        // Trigger
        const triggerResp = await fetch(`${BRIGHTDATA_BASE}/discover`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${brightdataApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            intent: body.prompt,
            language: 'en',
            num_results: 10,
            country: 'US',
            format: 'json',
            remove_duplicates: true,
            include_content: false,
          }),
        });
        if (!triggerResp.ok) return null;

        const triggerData = await triggerResp.json();
        const taskId = triggerData.task_id;
        if (!taskId) return null;

        // Poll (max 15s to fit within edge 25s limit)
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const pollResp = await fetch(`${BRIGHTDATA_BASE}/discover?task_id=${taskId}`, {
            headers: { Authorization: `Bearer ${brightdataApiKey}` },
          });
          if (!pollResp.ok) continue;

          const pollData = await pollResp.json();
          if (pollData.status === 'done' && Array.isArray(pollData.results) && pollData.results.length > 0) {
            const results: SearchResult[] = pollData.results.slice(0, 10).map((r: Record<string, unknown>) => ({
              title: String(r.title || ''),
              snippet: String(r.description || ''),
              url: String(r.url || r.link || ''),
              source: 'discover',
            })).filter((r: SearchResult) => r.url);

            if (results.length > 0) {
              return { results, summary: buildSummary(results, body.prompt) };
            }
          }

          if (pollData.status !== 'processing' && pollData.status !== 'ok') break;
        }

        return null;
      },
    },
  ];

  const chainResult = await executeFallbackChain(layers, 'enrichment-custom');

  if (!chainResult.data) {
    await sql`INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit) VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)`;
    return jsonResponse({ error: 'No search results found', layerLog: chainResult.layerLog }, cors, 404);
  }

  const isCacheHit = chainResult.source === 'cache';

  if (!isCacheHit) {
    const enrichmentJson = JSON.stringify(chainResult.data);
    await sql`
      INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
      VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, ${chainResult.source}, now() + make_interval(days => ${CACHE_TTL_DAYS}))
      ON CONFLICT (entity_type, entity_key)
      DO UPDATE SET enrichment_data = ${enrichmentJson}::jsonb, source = ${chainResult.source}, fetched_at = now(), expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
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
