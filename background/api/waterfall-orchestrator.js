/**
 * background/api/waterfall-orchestrator.js
 *
 * Meeting Intel – Waterfall Fetch Orchestrator
 *
 * Executes a multi-layer lookup cascade for a given person:
 *
 *   Layer 1 – Cache check (instant)
 *   Layer 2 – SERP Discovery: Google Search for LinkedIn URL via email/name
 *   Layer 3+4 – LinkedIn Scrape + Business Enriched (parallel, using URL from Layer 2)
 *   Layer 5 – Deep Lookup fallback (name + company, when SERP fails)
 *   Layer 6 – Error
 *
 * @module waterfall-orchestrator
 */

'use strict';

import {
  scrapeByLinkedInUrl,
  pollSnapshotUntilReady,
  downloadSnapshot,
} from './bright-data-scraper.js';

import { deepLookupByName } from './bright-data-deep-lookup.js';

import {
  serpFindLinkedInUrl,
  scrapeBusinessEnriched,
} from './bright-data-serp.js';

import { pickBestProfile, mergeBusinessEnrichedData } from './response-normalizer.js';

const LOG_PREFIX = '[Meeting Intel][Waterfall]';

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LAYER_TIMEOUTS = {
  serpDiscovery:       20_000,
  linkedInAndEnrich:   55_000,
  deepLookup:          45_000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normaliseCacheKey(value) {
  return (value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
}

function withTimeout(promise, ms, layerName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[${layerName}] timed out after ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// ─── WaterfallOrchestrator ───────────────────────────────────────────────────

export class WaterfallOrchestrator {

  constructor(cacheManager, apiToken) {
    this._cache = cacheManager;
    this._apiToken = apiToken;
    this.onProgress = null;
  }

  _notifyProgress(label) {
    if (typeof this.onProgress !== 'function') return;
    try { this.onProgress(label); } catch (_) { /* swallow */ }
  }

  async _runLayer(layerName, progressLabel, fn, timeoutMs) {
    this._notifyProgress(progressLabel);
    console.log(LOG_PREFIX, `Layer: ${layerName}`);
    const start = Date.now();

    try {
      const result = await withTimeout(fn(), timeoutMs, layerName);
      const elapsedMs = Date.now() - start;
      console.log(LOG_PREFIX, `Layer ${layerName} ${result.success ? 'succeeded' : 'no data'} in ${elapsedMs}ms`);
      return { ...result, elapsedMs };
    } catch (err) {
      const elapsedMs = Date.now() - start;
      console.warn(LOG_PREFIX, `Layer ${layerName} failed in ${elapsedMs}ms: ${err.message}`);
      return { success: false, error: err.message, elapsedMs };
    }
  }

  // ── Layer implementations ─────────────────────────────────────────────────

  async _layerCache(cacheKey) {
    const cached = await this._cache.get(cacheKey);
    if (cached) return { success: true, _cachedData: cached };
    return { success: false };
  }

  /**
   * Layer 2: SERP Discovery – find LinkedIn URL via Google Search.
   * Tries email first (most specific), then "name company" as fallback.
   */
  async _layerSerpDiscovery(email, name, company) {
    let linkedInUrl = null;

    // Primary: search by email
    if (email && email.includes('@')) {
      console.log(LOG_PREFIX, 'SERP: searching by email:', email);
      linkedInUrl = await serpFindLinkedInUrl(email, this._apiToken);
    }

    // Fallback: search by "name company"
    if (!linkedInUrl && name) {
      const query = company ? `${name} ${company}` : name;
      console.log(LOG_PREFIX, 'SERP: searching by name:', query);
      linkedInUrl = await serpFindLinkedInUrl(query, this._apiToken);
    }

    if (!linkedInUrl) {
      return { success: false, error: 'SERP found no LinkedIn URL' };
    }

    return { success: true, linkedInUrl, source: 'serp' };
  }

  /**
   * Layer 3+4: LinkedIn Scrape + Business Enriched (parallel).
   * Both use the LinkedIn URL discovered by SERP.
   */
  async _layerLinkedInAndEnrich(linkedInUrl) {
    const [scrapeResult, enrichResult] = await Promise.allSettled([
      scrapeByLinkedInUrl(linkedInUrl, this._apiToken),
      scrapeBusinessEnriched(linkedInUrl, this._apiToken),
    ]);

    let profiles = [];
    let enrichedData = null;

    // Process LinkedIn People scrape
    if (scrapeResult.status === 'fulfilled') {
      const result = scrapeResult.value;
      if (result.mode === 'direct') {
        profiles = result.profiles || [];
      } else if (result.mode === 'snapshot' && result.snapshotId) {
        try {
          await pollSnapshotUntilReady(result.snapshotId, this._apiToken);
          profiles = await downloadSnapshot(result.snapshotId, this._apiToken);
        } catch (err) {
          console.warn(LOG_PREFIX, 'LinkedIn snapshot poll failed:', err.message);
        }
      }
    } else {
      console.warn(LOG_PREFIX, 'LinkedIn scrape failed:', scrapeResult.reason?.message);
    }

    // Process Business Enriched
    if (enrichResult.status === 'fulfilled') {
      const result = enrichResult.value;
      if (result.mode === 'direct') {
        enrichedData = result.profiles;
      } else if (result.mode === 'snapshot' && result.snapshotId) {
        try {
          await pollSnapshotUntilReady(result.snapshotId, this._apiToken);
          enrichedData = await downloadSnapshot(result.snapshotId, this._apiToken);
        } catch (err) {
          console.warn(LOG_PREFIX, 'Business Enriched snapshot poll failed:', err.message);
        }
      }
    } else {
      console.warn(LOG_PREFIX, 'Business Enriched failed:', enrichResult.reason?.message);
    }

    if (!profiles.length && (!enrichedData || !enrichedData.length)) {
      return { success: false, error: 'Both scrape and enrichment returned empty' };
    }

    return {
      success: true,
      profiles,
      enrichedData,
      source: 'brightdata-serp-enriched',
    };
  }

  /**
   * Layer 5: Deep Lookup by name + company (fallback when SERP fails).
   */
  async _layerDeepLookup(name, company) {
    if (!name) return { success: false, error: 'No name for deep lookup' };

    const profiles = await deepLookupByName(name, company, this._apiToken);
    if (!profiles || profiles.length === 0) {
      return { success: false, error: 'Deep lookup returned no profiles' };
    }
    return { success: true, profiles, source: 'brightdata-deep' };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async fetch(payload) {
    const { name, email, company } = payload;
    const identifier = name || email || 'unknown';
    const cacheKey = `person_${normaliseCacheKey(email || name || identifier)}`;

    console.log(LOG_PREFIX, `Waterfall started for: "${identifier}"`);

    // ── Layer 1: Cache ──────────────────────────────────────────────────────
    const cacheResult = await this._runLayer(
      'cache', 'Checking cache...', () => this._layerCache(cacheKey), 500
    );
    if (cacheResult.success && cacheResult._cachedData) {
      console.log(LOG_PREFIX, `Cache hit for "${identifier}"`);
      return cacheResult._cachedData;
    }

    // ── Layer 2: SERP Discovery ─────────────────────────────────────────────
    const serpResult = await this._runLayer(
      'serp-discovery',
      'Searching Google for LinkedIn profile...',
      () => this._layerSerpDiscovery(email, name, company),
      LAYER_TIMEOUTS.serpDiscovery
    );

    if (serpResult.success && serpResult.linkedInUrl) {
      // ── Layer 3+4: LinkedIn Scrape + Business Enriched (parallel) ───────
      const enrichedResult = await this._runLayer(
        'linkedin-enriched',
        'Fetching LinkedIn profile & business data...',
        () => this._layerLinkedInAndEnrich(serpResult.linkedInUrl),
        LAYER_TIMEOUTS.linkedInAndEnrich
      );

      if (enrichedResult.success) {
        const data = await this._finalise(
          enrichedResult, name, email, cacheKey, identifier,
          { serpVerified: true }
        );
        if (data) return data;
      }
    }

    // ── Layer 5: Deep Lookup (fallback) ─────────────────────────────────────
    const deepResult = await this._runLayer(
      'deep-lookup',
      'Trying deep lookup...',
      () => this._layerDeepLookup(name, company),
      LAYER_TIMEOUTS.deepLookup
    );

    if (deepResult.success) {
      const data = await this._finalise(
        deepResult, name, email, cacheKey, identifier,
        { serpVerified: false }
      );
      if (data) return data;
    }

    // ── Layer 6: All failed ─────────────────────────────────────────────────
    this._notifyProgress('No data found');
    const errors = [serpResult, deepResult]
      .filter((r) => r.error)
      .map((r) => r.error)
      .join('; ');

    throw new Error(
      `All lookup layers failed for "${identifier}". Errors: ${errors || 'unknown'}`
    );
  }

  /**
   * Normalise, merge enriched data, quality-gate, cache, and return PersonData.
   * Returns null if result is too thin (name=Unknown + low confidence).
   */
  async _finalise(layerResult, name, email, cacheKey, identifier, context = {}) {
    const { profiles, enrichedData, source } = layerResult;

    const personData = pickBestProfile(profiles, name, source, {
      email,
      serpVerified: context.serpVerified || false,
    });

    if (!personData) {
      console.log(LOG_PREFIX, `No usable profile for "${identifier}" from "${source}"`);
      return null;
    }

    // Quality gate: skip low-quality Unknown results.
    if (personData.name === 'Unknown' && personData._confidence === 'low') {
      console.log(LOG_PREFIX, `Low-quality result for "${identifier}" from "${source}" — skipping`);
      return null;
    }

    // Merge business enriched data if available.
    if (enrichedData && Array.isArray(enrichedData) && enrichedData.length > 0) {
      const merged = mergeBusinessEnrichedData(personData, enrichedData[0]);
      Object.assign(personData, merged);
    }

    // Carry over calendar email.
    if (email && !personData.email) {
      personData.email = email;
    }

    // Cache (non-fatal).
    try {
      await this._cache.set(cacheKey, personData, CACHE_TTL_MS);
    } catch (err) {
      console.warn(LOG_PREFIX, `Cache write failed for "${identifier}":`, err.message);
    }

    console.log(
      LOG_PREFIX,
      `Waterfall complete for "${personData.name}" — source: ${personData._source}, confidence: ${personData._confidence}`
    );

    return personData;
  }
}
