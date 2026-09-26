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

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';
import { deepLookup, CONTACT_LOOKUP_SPEC } from './_shared/deep-lookup';
import { reserveCredits, refundCredits, rolloverIfNeeded } from './_shared/credits';
import { searchDataset, SEARCH_DATASETS } from './_shared/search-dataset';

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

  // Step 5: Reserve credits atomically BEFORE the paid lookup (contact costs 2).
  // A single conditional UPDATE closes the check-then-spend race; we refund on
  // failure so a failed lookup never charges.
  await rolloverIfNeeded(userId);
  const brightdataApiKey = process.env.BRIGHTDATA_API_KEY;
  if (!brightdataApiKey) {
    return jsonResponse({ error: 'Enrichment service not configured' }, cors, 503);
  }

  const reserved = await reserveCredits(userId, CREDITS_PER_CONTACT);
  if (reserved === null) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsLimit: user.credits_limit,
      creditsRequired: CREDITS_PER_CONTACT,
      tier: user.subscription_tier,
    }, cors, 402);
  }

  // Step 6: fetch contact info. Fast path first — the synchronous Search API on
  // the contact-enriched people dataset returns phone/email inline in ~1s. Fall
  // back to the slower Deep Lookup only when search has no usable contact fields.
  let contactRaw: Record<string, unknown> | null = null;
  let source = 'search-dataset';
  let latencyMs = 0;

  try {
    const search = await searchDataset(
      SEARCH_DATASETS.peopleContactEnriched,
      [{ name: 'url', operator: '=', value: body.linkedinUrl }],
      brightdataApiKey,
      { size: 1, timeoutMs: 12_000 },
    );
    latencyMs = search.latencyMs;
    if (search.records.length > 0) {
      const candidate = normalizeContactData(search.records[0]);
      if (candidate.phone || candidate.email) {
        contactRaw = search.records[0];
      }
    }
  } catch (err) {
    console.warn('[enrichment-contact] Search API error (falling back to deep-lookup):', (err as Error).message);
  }

  if (!contactRaw) {
    const input: Record<string, string> = {
      linkedin_url: body.linkedinUrl,
      full_name: body.fullName,
    };
    const result = await deepLookup(CONTACT_LOOKUP_SPEC, input, brightdataApiKey, 20_000);
    latencyMs = result.latencyMs;
    source = 'deep-lookup';
    if (!result.data) {
      await refundCredits(userId, CREDITS_PER_CONTACT);
      await sql`
        INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
        VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
      `;
      return jsonResponse({
        error: 'No contact data found',
        detail: result.error,
        latencyMs,
      }, cors, 404);
    }
    contactRaw = result.data;
  }

  const contactData = normalizeContactData(contactRaw);
  const enrichmentJson = JSON.stringify(contactData);

  // Step 7: Cache (14-day TTL)
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, ${source}, now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      source = ${source},
      fetched_at = now(),
      expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;
  sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`.catch(() => {});

  // Step 8: Credits already reserved atomically above; just log the success.
  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'person', ${entityKey}, ${CREDITS_PER_CONTACT}, 'success', false, now())
  `;

  return jsonResponse({
    data: contactData,
    source,
    cached: false,
    fetchedAt: new Date().toISOString(),
    latencyMs,
    creditsUsed: CREDITS_PER_CONTACT,
  }, cors);
}
