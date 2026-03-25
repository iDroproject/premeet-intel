// PreMeet – Supabase Enrichment Cache Service
// Server-side caching layer for enrichment results.
// Provides cache-first lookup, TTL-based expiry, manual invalidation,
// in-flight deduplication, and hit/miss tracking.

import { supabase } from './supabase';
import type { Database, EntityType, ConfidenceLevel } from './database.types';

const LOG_PREFIX = '[PreMeet][SupabaseCache]';

const TTL_DEFAULTS: Record<EntityType, number> = {
  person: 7 * 24 * 60 * 60 * 1000,   // 7 days
  company: 30 * 24 * 60 * 60 * 1000,  // 30 days
};

// Row types extracted from Database for explicit annotations
type EnrichmentCacheRow = Database['public']['Tables']['enrichment_cache']['Row'];
type EnrichmentCacheInsert = Database['public']['Tables']['enrichment_cache']['Insert'];
type CacheStatsRow = Database['public']['Tables']['cache_stats']['Row'];

export interface CacheLookupResult {
  hit: boolean;
  data: Record<string, unknown> | null;
  confidence: ConfidenceLevel | null;
  confidenceScore: number | null;
  source: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
}

export interface CacheStoreParams {
  entityType: EntityType;
  entityKey: string;
  enrichmentData: Record<string, unknown>;
  confidence?: ConfidenceLevel | null;
  confidenceScore?: number | null;
  source?: string | null;
  ttlMs?: number;
}

// In-flight request deduplication map.
// Key: `${entityType}:${entityKey}`, Value: pending promise.
const inflight = new Map<string, Promise<CacheLookupResult>>();

function inflightKey(entityType: EntityType, entityKey: string): string {
  return `${entityType}:${entityKey.trim().toLowerCase()}`;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export class EnrichmentCacheService {
  // ── Cache Lookup (cache-first) ──────────────────────────────────────────

  async get(entityType: EntityType, entityKey: string): Promise<CacheLookupResult> {
    const key = normalizeKey(entityKey);
    const dedup = inflightKey(entityType, key);

    // Deduplication: if an identical lookup is already in-flight, await it
    const pending = inflight.get(dedup);
    if (pending) {
      console.log(LOG_PREFIX, `Dedup hit for ${dedup}, awaiting in-flight request`);
      return pending;
    }

    const promise = this._lookup(entityType, key);
    inflight.set(dedup, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      inflight.delete(dedup);
    }
  }

  private async _lookup(entityType: EntityType, entityKey: string): Promise<CacheLookupResult> {
    const miss: CacheLookupResult = {
      hit: false,
      data: null,
      confidence: null,
      confidenceScore: null,
      source: null,
      fetchedAt: null,
      expiresAt: null,
    };

    try {
      const { data, error } = await supabase
        .from('enrichment_cache')
        .select('enrichment_data, confidence, confidence_score, source, fetched_at, expires_at')
        .eq('entity_type', entityType)
        .eq('entity_key', entityKey)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (error) {
        console.error(LOG_PREFIX, 'Lookup error:', error.message);
        await this._recordStat(entityType, false);
        return miss;
      }

      if (!data) {
        console.log(LOG_PREFIX, `Cache miss: ${entityType}/${entityKey}`);
        await this._recordStat(entityType, false);
        return miss;
      }

      console.log(LOG_PREFIX, `Cache hit: ${entityType}/${entityKey}`);
      await this._recordStat(entityType, true);

      const row = data as unknown as Pick<EnrichmentCacheRow, 'enrichment_data' | 'confidence' | 'confidence_score' | 'source' | 'fetched_at' | 'expires_at'>;
      return {
        hit: true,
        data: row.enrichment_data as Record<string, unknown>,
        confidence: row.confidence,
        confidenceScore: row.confidence_score,
        source: row.source,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
      };
    } catch (err) {
      console.error(LOG_PREFIX, 'Unexpected lookup error:', (err as Error).message);
      await this._recordStat(entityType, false);
      return miss;
    }
  }

  // ── Store ───────────────────────────────────────────────────────────────

  async put(params: CacheStoreParams): Promise<boolean> {
    const {
      entityType,
      entityKey,
      enrichmentData,
      confidence = null,
      confidenceScore = null,
      source = null,
      ttlMs,
    } = params;

    const key = normalizeKey(entityKey);
    const ttl = ttlMs ?? TTL_DEFAULTS[entityType];
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    const row: EnrichmentCacheInsert = {
      entity_type: entityType,
      entity_key: key,
      enrichment_data: enrichmentData,
      confidence,
      confidence_score: confidenceScore,
      source,
      fetched_at: new Date().toISOString(),
      expires_at: expiresAt,
    };

    try {
      const { error } = await supabase
        .from('enrichment_cache')
        .upsert(row as never, { onConflict: 'entity_type,entity_key' });

      if (error) {
        console.error(LOG_PREFIX, 'Store error:', error.message);
        return false;
      }

      console.log(LOG_PREFIX, `Stored ${entityType}/${key} (expires: ${expiresAt})`);
      return true;
    } catch (err) {
      console.error(LOG_PREFIX, 'Unexpected store error:', (err as Error).message);
      return false;
    }
  }

  // ── Invalidate ──────────────────────────────────────────────────────────

  async invalidate(entityType: EntityType, entityKey: string): Promise<boolean> {
    const key = normalizeKey(entityKey);

    try {
      const { error } = await supabase
        .from('enrichment_cache')
        .delete()
        .eq('entity_type', entityType as never)
        .eq('entity_key', key as never);

      if (error) {
        console.error(LOG_PREFIX, 'Invalidate error:', error.message);
        return false;
      }

      console.log(LOG_PREFIX, `Invalidated ${entityType}/${key}`);
      return true;
    } catch (err) {
      console.error(LOG_PREFIX, 'Unexpected invalidate error:', (err as Error).message);
      return false;
    }
  }

  // ── Stats Recording ─────────────────────────────────────────────────────

  private async _recordStat(entityType: EntityType, hit: boolean): Promise<void> {
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    try {
      const { error } = await supabase.rpc('upsert_cache_stat' as never, {
        p_date: dateKey,
        p_entity_type: entityType,
        p_hits: hit ? 1 : 0,
        p_misses: hit ? 0 : 1,
      } as never);

      if (error) {
        console.warn(LOG_PREFIX, 'Stats record failed:', (error as { message: string }).message);
      }
    } catch {
      // Silently ignore stats failures — they must never block lookups
    }
  }

  // ── Get Stats ───────────────────────────────────────────────────────────

  async getStats(days: number = 7): Promise<{
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    daily: Array<{ date: string; entityType: EntityType; hits: number; misses: number }>;
  }> {
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    try {
      const { data, error } = await supabase
        .from('cache_stats')
        .select('date, entity_type, hits, misses')
        .gte('date', sinceDate as never)
        .order('date', { ascending: false });

      if (error || !data) {
        console.warn(LOG_PREFIX, 'Stats fetch failed:', error?.message);
        return { totalHits: 0, totalMisses: 0, hitRate: 0, daily: [] };
      }

      const rows = data as unknown as Array<Pick<CacheStatsRow, 'date' | 'entity_type' | 'hits' | 'misses'>>;
      const totalHits = rows.reduce((sum, r) => sum + (r.hits ?? 0), 0);
      const totalMisses = rows.reduce((sum, r) => sum + (r.misses ?? 0), 0);
      const total = totalHits + totalMisses;

      return {
        totalHits,
        totalMisses,
        hitRate: total > 0 ? totalHits / total : 0,
        daily: rows.map((r) => ({
          date: r.date,
          entityType: r.entity_type,
          hits: r.hits ?? 0,
          misses: r.misses ?? 0,
        })),
      };
    } catch (err) {
      console.warn(LOG_PREFIX, 'Stats fetch error:', (err as Error).message);
      return { totalHits: 0, totalMisses: 0, hitRate: 0, daily: [] };
    }
  }
}
