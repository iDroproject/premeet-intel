// PreMeet — MCP Enrichment Function
// POST /api/enrichment-mcp
//
// Connects to BrightData MCP endpoint to fetch Crunchbase + ZoomInfo
// company data in parallel. Returns unified CompanyIntel JSON.
//
// Request body:
//   { "companyName": string, "companyDomain?": string }
//
// Feature flag: MCP_ENRICHMENT (env). When "false", returns 503.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from '../_shared/cors';
import { requireAuth } from '../_shared/auth-middleware';
import { sql } from '../_shared/db';
import { aggregateCompanyIntel } from './aggregator';
import type { EnrichmentMcpRequest } from './types';

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

  // Feature flag check
  const mcpEnabled = process.env.MCP_ENRICHMENT;
  if (mcpEnabled === 'false') {
    return jsonResponse({ error: 'MCP enrichment is disabled' }, cors, 503);
  }

  // Step 1: Authenticate
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.context;

  // Step 2: Parse and validate request
  let body: EnrichmentMcpRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!body.companyName || typeof body.companyName !== 'string') {
    return jsonResponse({ error: 'Missing required field: companyName' }, cors, 400);
  }

  if (body.companyName.length > 200) {
    return jsonResponse({ error: 'companyName exceeds maximum length (200)' }, cors, 400);
  }

  if (body.companyDomain && (typeof body.companyDomain !== 'string' || body.companyDomain.length > 253)) {
    return jsonResponse({ error: 'Invalid companyDomain' }, cors, 400);
  }

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
    await sql`
      UPDATE users
      SET credits_used = 0, credits_reset_month = ${currentMonth}
      WHERE id = ${userId}
    `;
    creditsUsed = 0;
  }

  if (user.subscription_tier === 'free' && creditsUsed >= user.credits_limit) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsUsed,
      creditsLimit: user.credits_limit,
      tier: user.subscription_tier,
    }, cors, 402);
  }

  // Step 4: Check MCP API key
  const mcpApiKey = process.env.MCP_API_KEY;
  if (!mcpApiKey) {
    return jsonResponse({ error: 'MCP enrichment service not configured' }, cors, 503);
  }

  // Step 5: Aggregate Crunchbase + ZoomInfo in parallel
  try {
    const { intel, sources, anyCached } = await aggregateCompanyIntel(
      body.companyName,
      body.companyDomain,
      userId,
      mcpApiKey,
    );

    // At least one source must succeed
    if (!sources.crunchbase.success && !sources.zoominfo.success) {
      return jsonResponse({
        error: 'Both enrichment sources failed',
        sources,
      }, cors, 502);
    }

    // Deduct 1 credit only if we got fresh data from at least one source
    const anyFreshFetch = !sources.crunchbase.cached || !sources.zoominfo.cached;
    if (anyFreshFetch) {
      await sql`
        UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}
      `;
    }

    return jsonResponse({
      data: intel,
      sources,
      cached: !anyFreshFetch,
      fetchedAt: new Date().toISOString(),
    }, cors);
  } catch (err) {
    console.error('[enrichment-mcp] Unexpected error:', (err as Error).message);
    return jsonResponse({ error: 'Internal server error' }, cors, 500);
  }
}
