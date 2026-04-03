// PreMeet — Enrichment Cache Edge Function
// Provides Neon-backed cache read/write/invalidate for the Chrome extension.
//
// Endpoints:
//   POST /functions/v1/enrichment-cache   { action: "get"|"put"|"invalidate"|"stats", ... }

export const config = { runtime: 'edge' };

import { corsHeaders, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';
import { sql } from './_shared/db';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ── GET: Cache lookup ────────────────────────────────────────────────────────

interface GetPayload {
  action: 'get';
  entityType: 'person' | 'company';
  entityKey: string;
}

// Grace period: serve stale data for up to 1x TTL after expiry (stale-while-revalidate)
const STALE_GRACE_MS: Record<string, number> = {
  person: 14 * 24 * 60 * 60 * 1000,  // 14 days grace after 14-day TTL
  company: 30 * 24 * 60 * 60 * 1000, // 30 days grace after 30-day TTL
};

async function handleGet(payload: GetPayload): Promise<Response> {
  const entityKey = payload.entityKey.trim().toLowerCase();
  const graceMs = STALE_GRACE_MS[payload.entityType] ?? STALE_GRACE_MS.person;
  const graceSeconds = Math.floor(graceMs / 1000);

  // Query includes stale grace window: entries expired but within grace are returned as stale
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

  // Record stat: fresh hit = hit, stale hit = still a hit (avoids re-fetch), miss = miss
  sql`SELECT upsert_cache_stat(CURRENT_DATE, ${payload.entityType}, ${hasRow ? 1 : 0}, ${hasRow ? 0 : 1})`.catch(() => {});

  if (!hasRow) {
    return jsonResponse({ hit: false, stale: false, data: null, confidence: null, confidenceScore: null, source: null, fetchedAt: null, expiresAt: null });
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
  });
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
  person: 14 * 24 * 60 * 60 * 1000,  // 14 days — profile data changes infrequently
  company: 30 * 24 * 60 * 60 * 1000, // 30 days
};

async function handlePut(payload: PutPayload): Promise<Response> {
  const entityKey = payload.entityKey.trim().toLowerCase();
  const ttlMs = payload.ttlMs ?? TTL_DEFAULTS[payload.entityType] ?? TTL_DEFAULTS.person;
  const ttlSeconds = Math.floor(ttlMs / 1000);
  const enrichmentJson = JSON.stringify(payload.enrichmentData);

  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, confidence, confidence_score, source, fetched_at, expires_at)
    VALUES (
      ${payload.entityType},
      ${entityKey},
      ${enrichmentJson}::jsonb,
      ${payload.confidence ?? null},
      ${payload.confidenceScore ?? null},
      ${payload.source ?? null},
      now(),
      now() + make_interval(secs => ${ttlSeconds})
    )
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${enrichmentJson}::jsonb,
      confidence = ${payload.confidence ?? null},
      confidence_score = ${payload.confidenceScore ?? null},
      source = ${payload.source ?? null},
      fetched_at = now(),
      expires_at = now() + make_interval(secs => ${ttlSeconds})
  `;

  return jsonResponse({ ok: true });
}

// ── INVALIDATE: Cache delete ─────────────────────────────────────────────────

interface InvalidatePayload {
  action: 'invalidate';
  entityType: 'person' | 'company';
  entityKey: string;
}

async function handleInvalidate(payload: InvalidatePayload): Promise<Response> {
  const entityKey = payload.entityKey.trim().toLowerCase();

  await sql`
    DELETE FROM enrichment_cache
    WHERE entity_type = ${payload.entityType}
      AND entity_key = ${entityKey}
  `;

  return jsonResponse({ ok: true });
}

// ── STATS: Cache statistics ──────────────────────────────────────────────────

interface StatsPayload {
  action: 'stats';
  days?: number;
}

async function handleStats(payload: StatsPayload): Promise<Response> {
  const days = payload.days ?? 7;
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
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────

type ActionPayload = GetPayload | PutPayload | InvalidatePayload | StatsPayload;

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Authenticate
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  // Parse body
  let body: ActionPayload;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.action) {
    return jsonResponse({ error: 'Missing required field: action' }, 400);
  }

  try {
    switch (body.action) {
      case 'get': {
        const p = body as GetPayload;
        if (!p.entityType || !p.entityKey) {
          return jsonResponse({ error: 'Missing entityType or entityKey' }, 400);
        }
        return await handleGet(p);
      }
      case 'put': {
        const p = body as PutPayload;
        if (!p.entityType || !p.entityKey || !p.enrichmentData) {
          return jsonResponse({ error: 'Missing entityType, entityKey, or enrichmentData' }, 400);
        }
        return await handlePut(p);
      }
      case 'invalidate': {
        const p = body as InvalidatePayload;
        if (!p.entityType || !p.entityKey) {
          return jsonResponse({ error: 'Missing entityType or entityKey' }, 400);
        }
        return await handleInvalidate(p);
      }
      case 'stats': {
        return await handleStats(body as StatsPayload);
      }
      default:
        return jsonResponse({ error: `Unknown action: ${(body as Record<string, unknown>).action}` }, 400);
    }
  } catch (err) {
    console.error('[PreMeet][enrichment-cache] Error:', (err as Error).message);
    return jsonResponse({ error: 'Internal server error' }, 500);
  }
}
