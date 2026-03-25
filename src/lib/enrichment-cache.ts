// PreMeet – Enrichment Cache Service (Neon-backed via Edge Function)
// Client-side caching layer that calls the enrichment-cache edge function
// for all server-side cache operations against the Neon database.
// Provides cache-first lookup, TTL-based expiry, manual invalidation,
// in-flight deduplication, and hit/miss tracking.

import { authFetch } from './auth';
import type { EntityType, ConfidenceLevel } from './database.types';

const LOG_PREFIX = '[PreMeet][ServerCache]';

function getApiBaseUrl(): string {
  const url = import.meta.env.VITE_API_BASE_URL as string;
  return url || '';
}

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

const CACHE_ENDPOINT = 'enrichment-cache';

export class EnrichmentCacheService {
  private _baseUrl: string;

  constructor() {
    this._baseUrl = getApiBaseUrl();
  }

  private async _call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this._baseUrl}/${CACHE_ENDPOINT}`;
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cache edge function error (${res.status}): ${errText.slice(0, 200)}`);
    }

    return res.json();
  }

  // ── Cache Lookup (cache-first) ──────────────────────────────────────────

  async get(entityType: EntityType, entityKey: string): Promise<CacheLookupResult> {
    const key = entityKey.trim().toLowerCase();
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
      return await promise;
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
      const result = await this._call({
        action: 'get',
        entityType,
        entityKey,
      });

      if (!result.hit) {
        console.log(LOG_PREFIX, `Cache miss: ${entityType}/${entityKey}`);
        return miss;
      }

      console.log(LOG_PREFIX, `Cache hit: ${entityType}/${entityKey}`);
      return {
        hit: true,
        data: result.data as Record<string, unknown>,
        confidence: (result.confidence as ConfidenceLevel) ?? null,
        confidenceScore: (result.confidenceScore as number) ?? null,
        source: (result.source as string) ?? null,
        fetchedAt: (result.fetchedAt as string) ?? null,
        expiresAt: (result.expiresAt as string) ?? null,
      };
    } catch (err) {
      console.error(LOG_PREFIX, 'Lookup error:', (err as Error).message);
      return miss;
    }
  }

  // ── Store ───────────────────────────────────────────────────────────────

  async put(params: CacheStoreParams): Promise<boolean> {
    try {
      await this._call({
        action: 'put',
        entityType: params.entityType,
        entityKey: params.entityKey,
        enrichmentData: params.enrichmentData,
        confidence: params.confidence ?? null,
        confidenceScore: params.confidenceScore ?? null,
        source: params.source ?? null,
        ttlMs: params.ttlMs,
      });

      console.log(LOG_PREFIX, `Stored ${params.entityType}/${params.entityKey}`);
      return true;
    } catch (err) {
      console.error(LOG_PREFIX, 'Store error:', (err as Error).message);
      return false;
    }
  }

  // ── Invalidate ──────────────────────────────────────────────────────────

  async invalidate(entityType: EntityType, entityKey: string): Promise<boolean> {
    try {
      await this._call({
        action: 'invalidate',
        entityType,
        entityKey,
      });

      console.log(LOG_PREFIX, `Invalidated ${entityType}/${entityKey}`);
      return true;
    } catch (err) {
      console.error(LOG_PREFIX, 'Invalidate error:', (err as Error).message);
      return false;
    }
  }

  // ── Get Stats ───────────────────────────────────────────────────────────

  async getStats(days: number = 7): Promise<{
    totalHits: number;
    totalMisses: number;
    hitRate: number;
    daily: Array<{ date: string; entityType: EntityType; hits: number; misses: number }>;
  }> {
    try {
      const result = await this._call({ action: 'stats', days });
      return {
        totalHits: (result.totalHits as number) ?? 0,
        totalMisses: (result.totalMisses as number) ?? 0,
        hitRate: (result.hitRate as number) ?? 0,
        daily: (result.daily as Array<{ date: string; entityType: EntityType; hits: number; misses: number }>) ?? [],
      };
    } catch (err) {
      console.warn(LOG_PREFIX, 'Stats fetch error:', (err as Error).message);
      return { totalHits: 0, totalMisses: 0, hitRate: 0, daily: [] };
    }
  }
}
