// PreMeet — Enrichment Cache Edge Function
// Provides Neon-backed cache read/write for the Chrome extension.
//
// POST /api/enrichment-cache   { action: "get"|"put"|"stats", ... }
//
// Hardened for production:
//   - Per-request CORS (no shared module-level state across concurrent requests).
//   - Premium (contact:) namespace is read-gated to Pro/Enterprise and can never
//     be written through this generic endpoint (only the server contact endpoint
//     writes it), so free users cannot bypass the paywall via the cache.
//   - Client 'invalidate' removed — arbitrary cache deletion was an abuse vector.
//   - Enum/size/ttl validation prevents 500s and unbounded storage growth.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth, type AuthContext } from './_shared/auth-middleware';
import { sql } from './_shared/db';

type Cors = Record<string, string>;

const ENTITY_TYPES = new Set(['person', 'company']);
const CONFIDENCE_LEVELS = new Set(['high', 'good', 'partial', 'low']);
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_PAYLOAD_BYTES = 200 * 1024;        // 200 KB
const MAX_KEY_LENGTH = 512;
/** Keys in this namespace hold premium (Pro-only) data. */
const PREMIUM_PREFIX = 'contact:';

function jsonResponse(body: unknown, cors: Cors, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function isPremiumKey(entityKey: string): boolean {
  return entityKey.trim().toLowerCase().startsWith(PREMIUM_PREFIX);
}

// ── GET: Cache lookup ────────────────────────────────────────────────────────

interface GetPayload {
  action: 'get';
  entityType: 'person' | 'company';
  entityKey: string;
}

// Grace period: serve stale data for up to 1x TTL after expiry (stale-while-revalidate)
const STALE_GRACE_MS: Record<string, number> = {
  person: 14 * 24 * 60 * 60 * 1000,
  company: 30 * 24 * 60 * 60 * 1000,
};

async function handleGet(payload: GetPayload, auth: AuthContext, cors: Cors): Promise<Response> {
  const entityKey = payload.entityKey.trim().toLowerCase();

  // Premium data is readable only by paying tiers — free users must not be able
  // to pull Pro-only contact info out of the shared cache.
  if (isPremiumKey(entityKey) && auth.tier === 'free') {
    return jsonResponse({ error: 'Pro subscription required' }, cors, 403);
  }

  const graceMs = STALE_GRACE_MS[payload.entityType] ?? STALE_GRACE_MS.person;
  const graceSeconds = Math.floor(graceMs / 1000);

  const rows = await sql`
    SELECT enrichment_data, confidence, confidence_score, source, fetched_at, expires_at,
           (expires_at > now()) AS is_fresh
    FROM enrichment_cache
    WHERE entity_type = ${payload.entityType}
      AND entity_key = ${entityKey}
      AND expires_at > now() - make_interval(secs => ${graceSeconds})
    LIMIT 1
  `;

  const hasRow = rows.length > 0;
  const isFresh = hasRow && rows[0].is_fresh;

  sql`SELECT upsert_cache_stat(CURRENT_DATE, ${payload.entityType}, ${hasRow ? 1 : 0}, ${hasRow ? 0 : 1})`.catch(() => {});

  if (!hasRow) {
    return jsonResponse({ hit: false, stale: false, data: null, confidence: null, confidenceScore: null, source: null, fetchedAt: null, expiresAt: null }, cors);
  }

  const row = rows[0];
  return jsonResponse({
    hit: true,
    stale: !isFresh,
    data: row.enrichment_data,
    confidence: row.confidence,
    confidenceScore: row.confidence_score,
    source: row.source,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  }, cors);
}

// ── PUT: Cache store ─────────────────────────────────────────────────────────

interface PutPayload {
  action: 'put';
  entityType: 'person' | 'company';
  entityKey: string;
  enrichmentData: Record<string, unknown>;
  confidence?: string | null;
  confidenceScore?: number | null;
  source?: string | null;
  ttlMs?: number;
}

const TTL_DEFAULTS: Record<string, number> = {
  person: 14 * 24 * 60 * 60 * 1000,
  company: 30 * 24 * 60 * 60 * 1000,
};

async function handlePut(payload: PutPayload, cors: Cors): Promise<Response> {
  const entityKey = payload.entityKey.trim().toLowerCase();

  // Validation — reject bad enums (would otherwise 500 on the Postgres cast) and
  // cap the ttl/size/key so a client can't poison the shared cache with huge or
  // long-lived junk.
  if (!ENTITY_TYPES.has(payload.entityType)) {
    return jsonResponse({ error: 'Invalid entityType' }, cors, 400);
  }
  if (payload.confidence != null && !CONFIDENCE_LEVELS.has(payload.confidence)) {
    return jsonResponse({ error: 'Invalid confidence' }, cors, 400);
  }
  if (entityKey.length === 0 || entityKey.length > MAX_KEY_LENGTH) {
    return jsonResponse({ error: 'Invalid entityKey length' }, cors, 400);
  }
  // The premium namespace is written only by the server-side contact endpoint.
  if (isPremiumKey(entityKey)) {
    return jsonResponse({ error: 'This namespace is not client-writable' }, cors, 403);
  }
  if (payload.enrichmentData == null || typeof payload.enrichmentData !== 'object') {
    return jsonResponse({ error: 'Missing enrichmentData' }, cors, 400);
  }

  const enrichmentJson = JSON.stringify(payload.enrichmentData);
  if (enrichmentJson.length > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: 'enrichmentData too large' }, cors, 413);
  }

  const requestedTtl = typeof payload.ttlMs === 'number' && payload.ttlMs > 0
    ? payload.ttlMs
    : (TTL_DEFAULTS[payload.entityType] ?? TTL_DEFAULTS.person);
  const ttlMs = Math.min(requestedTtl, MAX_TTL_MS);
  const ttlSeconds = Math.floor(ttlMs / 1000);
  const confidenceScore =
    typeof payload.confidenceScore === 'number' && Number.isFinite(payload.confidenceScore)
      ? payload.confidenceScore
      : null;

  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, confidence, confidence_score, source, fetched_at, expires_at)
    VALUES (
      ${payload.entityType},
      ${entityKey},
      ${enrichmentJson}::jsonb,
      ${payload.confidence ?? null},
      ${confidenceScore},
      ${payload.source ?? null},
      now(),
      now() + make_interval(secs => ${ttlSeconds})
    )
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      confidence = ${payload.confidence ?? null},
      confidence_score = ${confidenceScore},
      source = ${payload.source ?? null},
      fetched_at = now(),
      expires_at = now() + make_interval(secs => ${ttlSeconds})
  `;

  return jsonResponse({ ok: true }, cors);
}

// ── STATS: Cache statistics ──────────────────────────────────────────────────

interface StatsPayload {
  action: 'stats';
  days?: number;
}

async function handleStats(payload: StatsPayload, cors: Cors): Promise<Response> {
  const days = Math.min(Math.max(Number(payload.days) || 7, 1), 90);
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await sql`
    SELECT date, entity_type, hits, misses
    FROM cache_stats
    WHERE date >= ${sinceDate}::date
    ORDER BY date DESC
  `;

  const totalHits = rows.reduce((sum: number, r: Record<string, number>) => sum + (r.hits ?? 0), 0);
  const totalMisses = rows.reduce((sum: number, r: Record<string, number>) => sum + (r.misses ?? 0), 0);
  const total = totalHits + totalMisses;

  return jsonResponse({
    totalHits,
    totalMisses,
    hitRate: total > 0 ? totalHits / total : 0,
    daily: rows.map((r: Record<string, unknown>) => ({
      date: r.date,
      entityType: r.entity_type,
      hits: (r.hits as number) ?? 0,
      misses: (r.misses as number) ?? 0,
    })),
  }, cors);
}

// ── Main handler ─────────────────────────────────────────────────────────────

type ActionPayload = GetPayload | PutPayload | StatsPayload;

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, cors, 405);
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  let body: ActionPayload;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, cors, 400);
  }

  if (!body.action) {
    return jsonResponse({ error: 'Missing required field: action' }, cors, 400);
  }

  try {
    switch (body.action) {
      case 'get': {
        const p = body as GetPayload;
        if (!p.entityType || !p.entityKey) {
          return jsonResponse({ error: 'Missing entityType or entityKey' }, cors, 400);
        }
        return await handleGet(p, auth.context, cors);
      }
      case 'put': {
        const p = body as PutPayload;
        if (!p.entityType || !p.entityKey || !p.enrichmentData) {
          return jsonResponse({ error: 'Missing entityType, entityKey, or enrichmentData' }, cors, 400);
        }
        return await handlePut(p, cors);
      }
      case 'stats': {
        return await handleStats(body as StatsPayload, cors);
      }
      default:
        return jsonResponse({ error: `Unknown action: ${(body as Record<string, unknown>).action}` }, cors, 400);
    }
  } catch (err) {
    console.error('[PreMeet][enrichment-cache] Error:', (err as Error).message);
    return jsonResponse({ error: 'Internal server error' }, cors, 500);
  }
}
