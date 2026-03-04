/**
 * background/api/waterfall-orchestrator.js
 *
 * Bright People Intel – Waterfall Fetch Orchestrator
 *
 * Executes a deterministic multi-layer lookup cascade for a given person:
 *
 *   Layer 1 – Cache check (instant)
 *   Layer 2 – SERP Discovery: Google Search → find LinkedIn URL
 *   Layer 3 – Deep Lookup fallback: natural-language query → find LinkedIn URL
 *   Layer 4 – LinkedIn Scraper (WSA): scrape profile → get LinkedIn ID
 *   Layer 5 – Filter API: query dataset by LinkedIn ID → enriched data
 *   Layer 6 – Error
 *
 * @module waterfall-orchestrator
 */

'use strict';

import {
  scrapeByLinkedInUrl,
  pollSnapshotUntilReady,
  downloadSnapshot,
  extractLinkedInId,
} from './bright-data-scraper.js';

import { deepLookupFindLinkedIn } from './bright-data-deep-lookup.js';

import { serpFindLinkedInUrl } from './bright-data-serp.js';

import { filterByLinkedInId } from './bright-data-filter.js';

import { pickBestProfile, mergeBusinessEnrichedData } from './response-normalizer.js';

const LOG_PREFIX = '[BPI][Waterfall]';

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PIPELINE_STEPS = [
  { id: 'cache',            label: 'Checking cache...',                icon: 'cache',     percent: 5  },
  { id: 'serp-discovery',   label: 'Searching Google for LinkedIn...', icon: 'search',    percent: 20 },
  { id: 'deep-lookup',      label: 'Deep lookup by email...',          icon: 'magnifier', percent: 40 },
  { id: 'linkedin-scraper', label: 'Scraping LinkedIn profile...',     icon: 'linkedin',  percent: 60 },
  { id: 'filter-enrich',    label: 'Fetching enriched data...',        icon: 'filter',    percent: 90 },
];

const LAYER_TIMEOUTS = {
  serpDiscovery:   35_000,
  deepLookup:      90_000,
  linkedInScraper: 60_000,
  filterEnrich:    75_000,
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

  constructor(cacheManager, apiToken, logBuffer) {
    this._cache = cacheManager;
    this._apiToken = apiToken;
    this._logBuffer = logBuffer || null;
    this._personName = '';
    this._stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));
    this.onProgress = null;
  }

  _notifyProgress(stepId, status) {
    const stepIndex = this._stepsState.findIndex(s => s.id === stepId);
    if (stepIndex >= 0) {
      this._stepsState[stepIndex].status = status;
    }

    const activeStep = this._stepsState.find(s => s.id === stepId);
    const payload = {
      label:      activeStep?.label || '',
      percent:    activeStep?.percent || 0,
      step:       stepIndex + 1,
      totalSteps: this._stepsState.length,
      stepId,
      stepStatus: status,
      personName: this._personName,
      stepsState: this._stepsState.map(s => ({ ...s })),
    };

    if (typeof this.onProgress !== 'function') return;
    try { Promise.resolve(this.onProgress(payload)).catch(() => {}); } catch (_) { /* swallow */ }
  }

  async _runLayer(layerName, stepId, fn, timeoutMs) {
    this._notifyProgress(stepId, 'active');
    console.log(LOG_PREFIX, `Layer: ${layerName}`);
    const start = Date.now();

    try {
      const result = await withTimeout(fn(), timeoutMs, layerName);
      const elapsedMs = Date.now() - start;
      const status = result.success ? 'completed' : 'failed';
      this._notifyProgress(stepId, status);
      if (this._logBuffer) {
        this._logBuffer.info('Waterfall', `${layerName} ${status} in ${elapsedMs}ms`);
      }
      console.log(LOG_PREFIX, `Layer ${layerName} ${status} in ${elapsedMs}ms`);
      return { ...result, elapsedMs };
    } catch (err) {
      const elapsedMs = Date.now() - start;
      this._notifyProgress(stepId, 'failed');
      if (this._logBuffer) {
        this._logBuffer.error('Waterfall', `${layerName} failed in ${elapsedMs}ms: ${err.message}`);
      }
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
   * Layer 2: SERP Discovery – find LinkedIn URL via async Google Search.
   * Tries email first, then "name company" as fallback.
   */
  async _layerSerpDiscovery(email, name, company) {
    let linkedInUrl = null;

    // Primary: search by email.
    if (email && email.includes('@')) {
      console.log(LOG_PREFIX, 'SERP: searching by email:', email);
      linkedInUrl = await serpFindLinkedInUrl(email, this._apiToken);
    }

    // Fallback: search by "name company".
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
   * Layer 3: Deep Lookup – find LinkedIn URL via natural language query.
   * Fallback when SERP fails.
   */
  async _layerDeepLookup(email, name, company) {
    const result = await deepLookupFindLinkedIn(email, name, company, this._apiToken);

    if (!result.linkedInUrl) {
      return { success: false, error: 'Deep Lookup found no LinkedIn URL' };
    }

    return {
      success: true,
      linkedInUrl: result.linkedInUrl,
      source: 'deep-lookup',
    };
  }

  /**
   * Layer 4: LinkedIn Scraper (WSA) – scrape profile to get LinkedIn ID.
   * Also returns profile data that we can use as a base.
   */
  async _layerLinkedInScraper(linkedInUrl) {
    const scrapeResult = await scrapeByLinkedInUrl(linkedInUrl, this._apiToken);

    let profiles = [];

    if (scrapeResult.mode === 'direct') {
      profiles = scrapeResult.profiles || [];
    } else if (scrapeResult.mode === 'snapshot' && scrapeResult.snapshotId) {
      await pollSnapshotUntilReady(scrapeResult.snapshotId, this._apiToken);
      profiles = await downloadSnapshot(scrapeResult.snapshotId, this._apiToken);
    }

    if (!profiles.length) {
      return { success: false, error: 'LinkedIn Scraper returned no profiles' };
    }

    // Extract LinkedIn ID from profile data (prefer linkedin_id over id/URL slug).
    const profile = profiles[0];
    const linkedInId = extractLinkedInId(profile, linkedInUrl);

    console.log(LOG_PREFIX, 'LinkedIn Scraper profile fields:', {
      id: profile?.id,
      linkedin_id: profile?.linkedin_id,
      linkedin_num_id: profile?.linkedin_num_id,
      name: profile?.name,
      url: profile?.url,
    });

    return {
      success: true,
      profiles,
      linkedInId,
      linkedInUrl,
      source: 'brightdata-scraper',
    };
  }

  /**
   * Layer 5: Filter API – query enriched data by LinkedIn ID.
   * Returns comprehensive profile data from the dataset.
   */
  async _layerFilterEnrich(linkedInId) {
    if (!linkedInId) {
      return { success: false, error: 'No LinkedIn ID for Filter API' };
    }

    const profiles = await filterByLinkedInId(linkedInId, this._apiToken);

    if (!profiles || profiles.length === 0) {
      return { success: false, error: 'Filter API returned no results' };
    }

    return {
      success: true,
      profiles,
      source: 'brightdata-filter',
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async fetch(payload) {
    const { name, email, company } = payload;
    const identifier = name || email || 'unknown';
    const cacheKey = `person_${normaliseCacheKey(email || name || identifier)}`;

    // Initialise per-fetch state.
    this._personName = name || email || 'unknown';
    this._stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    console.log(LOG_PREFIX, `Waterfall started for: "${identifier}"`);

    // ── Layer 1: Cache ────────────────────────────────────────────────────
    const cacheResult = await this._runLayer(
      'cache', 'cache', () => this._layerCache(cacheKey), 500
    );
    if (cacheResult.success && cacheResult._cachedData) {
      console.log(LOG_PREFIX, `Cache hit for "${identifier}"`);
      for (const step of this._stepsState) {
        if (step.status === 'pending') this._notifyProgress(step.id, 'skipped');
      }
      return cacheResult._cachedData;
    }

    // ── Layer 2: SERP Discovery ───────────────────────────────────────────
    let linkedInUrl = null;

    const serpResult = await this._runLayer(
      'serp-discovery', 'serp-discovery',
      () => this._layerSerpDiscovery(email, name, company),
      LAYER_TIMEOUTS.serpDiscovery
    );

    if (serpResult.success && serpResult.linkedInUrl) {
      linkedInUrl = serpResult.linkedInUrl;
      // Deep lookup not needed — mark skipped.
      this._notifyProgress('deep-lookup', 'skipped');
    }

    // ── Layer 3: Deep Lookup (fallback if SERP failed) ────────────────────
    if (!linkedInUrl) {
      const deepResult = await this._runLayer(
        'deep-lookup', 'deep-lookup',
        () => this._layerDeepLookup(email, name, company),
        LAYER_TIMEOUTS.deepLookup
      );

      if (deepResult.success && deepResult.linkedInUrl) {
        linkedInUrl = deepResult.linkedInUrl;
      }
    }

    // If we still have no LinkedIn URL, all discovery failed.
    if (!linkedInUrl) {
      this._notifyProgress('linkedin-scraper', 'skipped');
      this._notifyProgress('filter-enrich', 'skipped');

      const errors = [serpResult.error, 'Deep Lookup found no LinkedIn URL']
        .filter(Boolean)
        .join('; ');
      throw new Error(
        `All discovery layers failed for "${identifier}". Errors: ${errors}`
      );
    }

    // ── Layer 4: LinkedIn Scraper → LinkedIn ID ───────────────────────────

    // Always run the scraper to get linkedin_id (needed for Filter API)
    // and base profile data. The URL slug alone isn't sufficient because
    // the Filter API requires the shorter `linkedin_id` field.
    let linkedInId = null;
    let scraperProfiles = null;

    {
      // Must scrape to get the LinkedIn ID.
      const scraperResult = await this._runLayer(
        'linkedin-scraper', 'linkedin-scraper',
        () => this._layerLinkedInScraper(linkedInUrl),
        LAYER_TIMEOUTS.linkedInScraper
      );

      if (scraperResult.success && scraperResult.linkedInId) {
        linkedInId = scraperResult.linkedInId;
        scraperProfiles = scraperResult.profiles;
      } else {
        // Can't get LinkedIn ID — skip filter, try to use scraper data.
        this._notifyProgress('filter-enrich', 'skipped');

        if (scraperResult.success && scraperResult.profiles?.length) {
          const data = await this._finalise(
            { profiles: scraperResult.profiles, source: 'brightdata-scraper' },
            name, email, cacheKey, identifier,
            { serpVerified: serpResult.success }
          );
          if (data) return data;
        }

        throw new Error(
          `Could not determine LinkedIn ID for "${identifier}"`
        );
      }
    }

    // ── Layer 5: Filter API → Enriched Data ───────────────────────────────
    const filterResult = await this._runLayer(
      'filter-enrich', 'filter-enrich',
      () => this._layerFilterEnrich(linkedInId),
      LAYER_TIMEOUTS.filterEnrich
    );

    if (filterResult.success && filterResult.profiles?.length) {
      // Use filter data as primary, merge with scraper data if available.
      const data = await this._finalise(
        {
          profiles: filterResult.profiles,
          scraperProfiles,
          source: 'brightdata-filter',
        },
        name, email, cacheKey, identifier,
        { serpVerified: serpResult.success }
      );
      if (data) return data;
    }

    // Filter failed or returned thin data — fall back to scraper profiles.
    if (scraperProfiles && scraperProfiles.length) {
      console.log(LOG_PREFIX, 'Filter failed, falling back to scraper data');
      const data = await this._finalise(
        { profiles: scraperProfiles, source: 'brightdata-scraper' },
        name, email, cacheKey, identifier,
        { serpVerified: serpResult.success }
      );
      if (data) return data;
    }

    // ── Layer 6: All enrichment failed ────────────────────────────────────
    throw new Error(
      `All enrichment layers failed for "${identifier}" (LinkedIn URL: ${linkedInUrl})`
    );
  }

  /**
   * Normalise, quality-gate, cache, and return PersonData.
   */
  async _finalise(layerResult, name, email, cacheKey, identifier, context = {}) {
    const { profiles, scraperProfiles, source } = layerResult;

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
      console.log(LOG_PREFIX, `Low-quality result for "${identifier}" — skipping`);
      return null;
    }

    // Merge scraper data if we used filter as primary.
    if (scraperProfiles?.length && source === 'brightdata-filter') {
      const merged = mergeBusinessEnrichedData(personData, scraperProfiles[0]);
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
