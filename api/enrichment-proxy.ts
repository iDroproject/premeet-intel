// PreMeet — BrightData Enrichment Proxy
// POST /api/enrichment-proxy
//
// Proxies enrichment API calls to BrightData so the Chrome extension
// never contacts api.brightdata.com directly. This keeps the BrightData
// API key server-side.
//
// Request body:
//   { "path": "/datasets/v3/scrape?dataset_id=...", "method": "GET"|"POST", "body": {...} }

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);

  if (req.method === 'OPTIONS') return corsResponse(req);

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  if (!brightdataApiKey) {
    return new Response(
      JSON.stringify({ error: 'Enrichment service not configured' }),
      { status: 503, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  let proxyReq: { path: string; method?: string; body?: unknown };
  try {
    proxyReq = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  if (!proxyReq.path || typeof proxyReq.path !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing required field: path' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  if (!proxyReq.path.startsWith('/')) {
    return new Response(
      JSON.stringify({ error: 'path must start with /' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const method = (proxyReq.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    return new Response(
      JSON.stringify({ error: 'Only GET and POST methods are supported' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const targetUrl = `${BRIGHTDATA_BASE}${proxyReq.path}`;

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
    return new Response(
      JSON.stringify({ error: `Upstream error: ${(err as Error).message}` }),
      { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const responseHeaders: Record<string, string> = {
    ...cors,
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  };

  const xResponseId = upstream.headers.get('x-response-id');
  if (xResponseId) {
    responseHeaders['x-response-id'] = xResponseId;
  }

  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) {
    responseHeaders['retry-after'] = retryAfter;
  }

  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
