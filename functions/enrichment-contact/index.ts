// PreMeet — Contact Info Enrichment Edge Function (Pro-only)
// POST /functions/v1/enrichment-contact
//
// Fetches direct contact info (phone, email) for a person via BrightData.
// Requires Pro subscription — Free users get 403 with upgrade message.
// Results cached in Neon (7-day TTL) and credit-deducted per fresh fetch.
//
// Request body:
//   { "linkedinUrl": string, "fullName": string, "companyName?": string }
//
// Returns: { phone, email, sources } or { status: "pending", snapshotId }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';
import { sql } from '../_shared/db.ts';
import { fetchWithRetry } from '../_shared/fetch-retry.ts';

const BRIGHTDATA_BASE = 'https://api.brightdata.com';
// BrightData contact discovery dataset — uses LinkedIn person profile to find contact info
const CONTACT_DATASET_ID = Deno.env.get('BRIGHTDATA_CONTACT_DATASET_ID') || 'gd_l1viktl72bvl7bjuj';
const CACHE_TTL_DAYS = 14; // 14 days — contact info changes infrequently

interface ContactRequest {
  linkedinUrl: string;
  fullName: string;
  companyName?: string;
}

interface ContactData {
  phone: string | null;
  email: string | null;
  sources: string[];
}

function buildEntityKey(req: ContactRequest): string {
  // Use LinkedIn URL as canonical key for contact lookups
  const match = req.linkedinUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  if (match) return `contact:linkedin:${decodeURIComponent(match[1]).toLowerCase().replace(/\/+$/, '')}`;
  // Fallback to name-based key
  return `contact:name:${req.fullName.toLowerCase().trim()}`;
}

function normalizeContactData(raw: Record<string, unknown>): ContactData {
  const sources: string[] = [];

  // Extract phone — BrightData may return various field names
  let phone: string | null = null;
  if (raw.phone_number) phone = String(raw.phone_number);
  else if (raw.phone) phone = String(raw.phone);
  else if (raw.mobile) phone = String(raw.mobile);
  else if (Array.isArray(raw.phone_numbers) && raw.phone_numbers.length > 0) {
    phone = String(raw.phone_numbers[0]);
  }

  // Extract email
  let email: string | null = null;
  if (raw.email) email = String(raw.email);
  else if (raw.email_address) email = String(raw.email_address);
  else if (Array.isArray(raw.emails) && raw.emails.length > 0) {
    email = String(raw.emails[0]);
  }

  // Track data sources
  if (raw.source) sources.push(String(raw.source));
  if (Array.isArray(raw.sources)) {
    for (const s of raw.sources) {
      if (typeof s === 'string') sources.push(s);
      else if (s && typeof s === 'object' && 'name' in s) sources.push(String(s.name));
    }
  }
  if (sources.length === 0) sources.push('brightdata');

  return { phone, email, sources };
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
  let body: ContactRequest;
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

  // Step 3: Verify Pro subscription (contact info is Pro-only)
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
      message: 'Contact info lookup is available on the Pro plan. Upgrade to access direct phone and email data.',
      tier: user.subscription_tier,
    }, 403);
  }

  const entityKey = buildEntityKey(body);

  // Step 4: Check Neon cache (7-day TTL)
  // NOTE: Using entity_type='person' with contact: key prefix.
  // PRE-98 will add 'contact_info' to the entity_type enum.
  const cached = await sql`
    SELECT enrichment_data, fetched_at, expires_at
    FROM enrichment_cache
    WHERE entity_type = 'person'
      AND entity_key = ${entityKey}
      AND expires_at > now()
    LIMIT 1
  `;

  if (cached.length > 0) {
    // Log cache hit (no credit deducted)
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'cached', true)
    `;

    // Update cache stats
    await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 1, 0)`;

    return jsonResponse({
      data: cached[0].enrichment_data,
      cached: true,
      fetchedAt: cached[0].fetched_at,
    });
  }

  // Step 5: Check credits (Pro users still have limits)
  const currentMonth = new Date().toISOString().slice(0, 7);

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

  if (creditsUsed >= user.credits_limit) {
    return jsonResponse({
      error: 'Credit limit reached',
      creditsUsed,
      creditsLimit: user.credits_limit,
      tier: user.subscription_tier,
    }, 402);
  }

  // Step 6: Call BrightData contact discovery endpoint
  const brightdataApiKey = Deno.env.get('BRIGHTDATA_API_KEY');
  if (!brightdataApiKey) {
    return jsonResponse({ error: 'Enrichment service not configured' }, 503);
  }

  const scrapeInput: Record<string, string> = { url: body.linkedinUrl };
  if (body.fullName) scrapeInput.full_name = body.fullName;
  if (body.companyName) scrapeInput.company_name = body.companyName;

  const scrapePath = `/datasets/v3/scrape?dataset_id=${CONTACT_DATASET_ID}&notify=false&include_errors=true`;

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
      'enrichment-contact',
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

    // Deduct credit now — will be fulfilled async
    await sql`
      UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}
    `;
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 1, 'pending', false)
    `;

    return jsonResponse({
      status: 'pending',
      snapshotId,
      message: 'Contact data is being fetched. Poll the snapshot endpoint for results.',
    }, 202);
  }

  // Synchronous response — parse and cache
  const rawData = await upstream.json();
  const profiles: Array<Record<string, unknown>> = Array.isArray(rawData) ? rawData : [rawData];
  const valid = profiles.filter((p) => !p.error && !p.error_code);

  if (valid.length === 0) {
    await sql`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES (${userId}, 'person', ${entityKey}, 0, 'failed', false)
    `;
    return jsonResponse({ error: 'No contact data found' }, 404);
  }

  const contactData = normalizeContactData(valid[0]);
  const enrichmentJson = JSON.stringify(contactData);

  // Step 7: Cache result in Neon (7-day TTL)
  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('person', ${entityKey}, ${enrichmentJson}::jsonb, 'brightdata', now() + make_interval(days => ${CACHE_TTL_DAYS}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      source = 'brightdata',
      fetched_at = now(),
      expires_at = now() + make_interval(days => ${CACHE_TTL_DAYS})
  `;

  // Update cache stats
  await sql`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`;

  // Step 8: Deduct 1 credit and log request
  await sql`
    UPDATE users SET credits_used = credits_used + 1 WHERE id = ${userId}
  `;
  await sql`
    INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
    VALUES (${userId}, 'person', ${entityKey}, 1, 'success', false, now())
  `;

  return jsonResponse({
    data: contactData,
    cached: false,
    fetchedAt: new Date().toISOString(),
  });
});
