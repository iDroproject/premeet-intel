// PreMeet — BrightData Enrichment Proxy
// POST /functions/v1/enrichment-proxy
//
// Proxies enrichment API calls to BrightData so the Chrome extension
// never contacts api.brightdata.com directly. This keeps the BrightData
// API key server-side and removes the host_permissions entry that was
// visible to users in the extension details page.
//
// Request body:
//   { "path": "/datasets/v3/scrape?dataset_id=...", "method": "GET"|"POST", "body": {...} }
//
// The function authenticates the caller via PreMeet JWT, then forwards
// the request to https://api.brightdata.com{path} using the server-side
// BRIGHTDATA_API_KEY secret.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Authenticate the caller
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Read BrightData API key from server-side env
  const brightdataApiKey = Deno.env.get('BRIGHTDATA_API_KEY');
  if (!brightdataApiKey) {
    return new Response(
      JSON.stringify({ error: 'Enrichment service not configured' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Parse proxy request
  let proxyReq: { path: string; method?: string; body?: unknown };
  try {
    proxyReq = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  if (!proxyReq.path || typeof proxyReq.path !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing required field: path' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Validate path starts with / to prevent open-redirect
  if (!proxyReq.path.startsWith('/')) {
    return new Response(
      JSON.stringify({ error: 'path must start with /' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const method = (proxyReq.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    return new Response(
      JSON.stringify({ error: 'Only GET and POST methods are supported' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
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

  // Forward to BrightData
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, fetchInit);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Upstream error: ${(err as Error).message}` }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Forward response headers we care about
  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
  };

  // Preserve x-response-id header (used by SERP unblocker)
  const xResponseId = upstream.headers.get('x-response-id');
  if (xResponseId) {
    responseHeaders['x-response-id'] = xResponseId;
  }

  const body = await upstream.text();

  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
