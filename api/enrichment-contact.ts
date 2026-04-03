// PreMeet — Contact Info Enrichment Edge Function (Pro-only, premium)
// POST /api/enrichment-contact
//
// Fetches direct contact info (phone, email) via Deep Lookup API.
// This is a premium feature — costs 2 credits per fresh fetch.
// Requires Pro subscription.
//
// Request body:
//   { "linkedinUrl": string, "fullName": string, "companyName?": string }
//
// Returns: { phone, email, sources } or error

// Node.js runtime — Deep Lookup polling can take 60s+
export const config = { maxDuration: 60 };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { deepLookup, CONTACT_LOOKUP_SPEC } from './_shared/deep-lookup';

const CACHE_TTL_DAYS = 14;
const CREDITS_PER_CONTACT = 2;

interface ContactRequest {
  linkedinUrl: string;
  fullName: string;
  companyName?: string;
}

interface ContactData {
  phone: string | null;
  email: string | null;
  twitter: string | null;
  github: string | null;
  sources: string[];
}

function buildEntityKey(req: ContactRequest): string {
  const match = req.linkedinUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  if (match) return `contact:linkedin:${decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '')}`;
  return `contact:name:${req.fullName.toLowerCase().trim()}`;
}

function normalizeContactData(raw: Record<string, unknown>): ContactData {
  const sources: string[] = ['deep-lookup'];

  let phone: string | null = null;
  if (raw.phone_number) phone = String(raw.phone_number);
  else if (raw.phone) phone = String(raw.phone);
  else if (raw.mobile) phone = String(raw.mobile);
  else if (Array.isArray(raw.phone_numbers) && raw.phone_numbers.length > 0) {
    phone = String(raw.phone_numbers[0]);
  }

  let email: string | null = null;
  if (raw.email) email = String(raw.email);
  else if (raw.email_address) email = String(raw.email_address);
  else if (Array.isArray(raw.emails) && raw.emails.length > 0) {
    email = String(raw.emails[0]);
  }

  const twitter = raw.twitter ? String(raw.twitter) : null;
  const github = raw.github ? String(raw.github) : null;

  return { phone, email, twitter, github, sources };
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

  // Step 2: Parse and validate
  let body: ContactRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!body.linkedinUrl || typeof body.linkedinUrl !== 'string') {
    return jsonResponse({ error: 'Missing required field: linkedinUrl' }, cors, 400);
  }
  if (!body.fullName || typeof body.fullName !== 'string') {
    return jsonResponse({ error: 'Missing required field: fullName' }, cors, 400);
  }

  // Step 3: Verify Pro subscription
  const userRows = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (userRows.length === 0) {
    return jsonResponse({ error: 'User not found' }, cors, 404);
  }

  const user = userRows[0];

  if (user.subscription_tier === 'free') {
    return jsonResponse({
      error: 'Pro subscription required',
      message: 'Contact info lookup is a premium feature available on the Pro plan.',
      tier: user.subscription_tier,
    }, cors, 403);
  }

  const entityKey = buildEntityKey(body);

  // Step 4: Check cache
  const cached = await sql`
    SELECT enrichment_data, fetched_at, expires_at
    FROM enrichment_cache
    WHERE entity_type = 'person' AND entity_key = ${entityKey} AND expires_at > now()
    LIMIT 1
  `;

  if (cached.length > 0) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'cached', true)
    `;
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 1, 0)`.catch(() => {});

    return jsonResponse({
      data: cached[0].enrichment_data,
      source: 'cache',
      cached: true,
      fetchedAt: cached[0].fetched_at,
    }, cors);
  }

  // Step 5: Check credits (contact costs 2 credits)
  const currentMonth = new Date().toISOString().slice(0, 7);
  let creditsUsed = user.credits_used;
  if (user.credits_reset_month !== currentMonth) {
    await sql`UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth} WHERE id = ${userId}`;
    creditsUsed = 0;
  }

  if (creditsUsed + CREDITS_PER_CONTACT > user.credits_limit) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsUsed,
      creditsLimit: user.credits_limit,
      creditsRequired: CREDITS_PER_CONTACT,
      tier: user.subscription_tier,
    }, cors, 402);
  }

  // Step 6: Deep Lookup for contact info
  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  if (!brightdataApiKey) {
    return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);
  }

  const input: Record<string, string> = {
    linkedin_url: body.linkedinUrl,
    full_name: body.fullName,
  };

  const result = await deepLookup(CONTACT_LOOKUP_SPEC, input, brightdataApiKey, 55_000);

  if (!result.data) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({
      error: 'No contact data found',
      detail: result.error,
      latencyMs: result.latencyMs,
    }, cors, 404);
  }

  const contactData = normalizeContactData(result.data);
  const enrichmentJson = JSON.stringify(contactData);

  // Step 7: Cache (14-day TTL)
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, 'deep-lookup', now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      source = 'deep-lookup',
      fetched_at = now(),
      expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;
  sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`.catch(() => {});

  // Step 8: Deduct 2 credits
  await sql`UPDATE users SET credits_used = credits_used + ${CREDITS_PER_CONTACT} WHERE id = ${userId}`;
  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'person', ${entityKey}, ${CREDITS_PER_CONTACT}, 'success', false, now())
  `;

  return jsonResponse({
    data: contactData,
    source: 'deep-lookup',
    cached: false,
    fetchedAt: new Date().toISOString(),
    latencyMs: result.latencyMs,
    creditsUsed: CREDITS_PER_CONTACT,
  }, cors);
}
