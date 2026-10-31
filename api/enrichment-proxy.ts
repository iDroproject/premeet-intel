// PreMeet — BrightData Enrichment Proxy
// POST /api/enrichment-proxy
//
// Proxies enrichment API calls to BrightData so the Chrome extension never
// contacts api.brightdata.com directly (the BrightData API key stays server-side).
//
// Hardened for production:
//   - Strict path allowlist (classifyProxyRequest) — no arbitrary paths.
//   - SSRF guard: the unblocker may only fetch Google search URLs.
//   - Server-side per-user daily op ceiling on billable triggers (anti-abuse).
//   - Billable triggers are audit-logged to enrichment_requests.
//   - SERP customer id is injected server-side (never trusted from the client).
//
// Request body:
//   { "path": "/datasets/v3/scrape?dataset_id=...", "method": "GET"|"POST", "body": {...} }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { classifyProxyRequest } from './_shared/brightdata-allowlist';
import { recordAndCheckOp } from './_shared/rate-limit';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';

function json(body: unknown, cors: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/**
 * For SERP unblocker calls, force the server's customer id and the serp zone so
 * the client can neither leak nor spoof the account's customer id.
 */
function rewriteSerpPath(rawPath: string): string {
  const u = new URL(rawPath, BRIGHTDATA_BASE);
  if (u.pathname === '/unblocker/req' || u.pathname === '/unblocker/get_result') {
    const customer = process.env.BRIGHTDATA_SERP_CUSTOMER_ID;
    if (customer) u.searchParams.set('customer', customer);
    u.searchParams.set('zone', 'serp');
  }
  return u.pathname + (u.search ? u.search : '');
}

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);

  if (req.method === 'OPTIONS') return corsResponse(req);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, cors, 405);

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId, tier } = auth.context;

  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  if (!brightdataApiKey) return json({ error: 'Enrichment service not configured' }, cors, 503);

  let proxyReq: { path: string; method?: string; body?: unknown };
  try {
    proxyReq = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!proxyReq.path || typeof proxyReq.path !== 'string' || !proxyReq.path.startsWith('/')) {
    return json({ error: 'Missing or invalid field: path' }, cors, 400);
  }

  const method = (proxyReq.method || 'GET').toUpperCase();

  // ── Allowlist + SSRF classification ──────────────────────────────────────
  const decision = classifyProxyRequest(method, proxyReq.path, proxyReq.body);
  if (!decision.ok) {
    return json({ error: decision.error || 'Request not allowed' }, cors, 403);
  }

  // ── Rate-limit + audit billable triggers ─────────────────────────────────
  if (decision.billable) {
    let rl;
    try {
      rl = await recordAndCheckOp(userId, tier);
    } catch (err) {
      // Fail closed on the ceiling check would break legit use during a DB blip;
      // fail open but log, since credits remain the hard billing gate elsewhere.
      console.warn('[enrichment-proxy] rate-limit check failed (allowing):', (err as Error).message);
      rl = { allowed: true, count: 0, cap: 0 };
    }
    if (!rl.allowed) {
      return json(
        { error: 'Daily usage limit reached. Please try again tomorrow or upgrade your plan.', cap: rl.cap },
        cors,
        429,
      );
    }
    // Best-effort audit trail (never blocks the request).
    sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${'proxy:' + decision.label}, 0, 'pending', false)
    `.catch(() => {});
  }

  const targetPath = rewriteSerpPath(proxyReq.path);
  const targetUrl = `${BRIGHTDATA_BASE}${targetPath}`;

  const fetchInit: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${brightdataApiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (method === 'POST' && proxyReq.body !== undefined) {
    fetchInit.body = JSON.stringify(proxyReq.body);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, fetchInit);
  } catch (err) {
    return json({ error: `Upstream error: ${(err as Error).message}` }, cors, 502);
  }

  const responseHeaders: Record<string, string> = {
    ...cors,
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  };
  const xResponseId = upstream.headers.get('x-response-id');
  if (xResponseId) responseHeaders['x-response-id'] = xResponseId;
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) responseHeaders['retry-after'] = retryAfter;

  const body = await upstream.text();
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}
