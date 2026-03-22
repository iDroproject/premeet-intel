/**
 * background/api/waterfall-orchestrator.js
 *
 * PreMeet – Waterfall Fetch Orchestrator
 *
 * Executes a deterministic multi-layer lookup cascade for a given person:
 *
 *   Layer 1 – Cache check (instant)
 *   Layer 2+3 – SERP Discovery and Deep Lookup run in parallel;
 *               whichever finds a LinkedIn URL first wins.
 *   Layer 4 – LinkedIn Scraper (WSA): scrape profile → get LinkedIn ID.
 *             Emits interim result immediately after scraper succeeds.
 *   Layer 5 – Filter API: query dataset by LinkedIn ID → enriched data.
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

import { deepLookupFindLinkedIn, deepLookupEnrich, deepLookupCompanyIntel } from './bright-data-deep-lookup.js';

import { serpFindLinkedInUrl, serpSearchCompanyInfo } from './bright-data-serp.js';

import { filterByLinkedInId } from './bright-data-filter.js';

import { pickBestProfile, mergeBusinessEnrichedData } from './response-normalizer.js';

const LOG_PREFIX = '[PreMeet][Waterfall]';

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
  filterEnrich:    130_000,
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
    // Callback fired immediately after the LinkedIn scraper returns data,
    // before the Filter API completes. Receives a PersonData object.
    this.onInterimResult = null;
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
      source: 'scraper',
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
      source: 'filter',
    };
  }

  // ── Parallel discovery ────────────────────────────────────────────────────

  /**
   * Run SERP (Layer 2) and Deep Lookup (Layer 3) concurrently.
   * Both step indicators are set to 'active' immediately.
   * As soon as one finds a LinkedIn URL it is returned; the other continues
   * in the background but its result is no longer awaited.
   *
   * The returned object always has shape:
   *   { linkedInUrl: string|null, serpVerified: boolean, errors: string[] }
   *
   * @param {string|null} email    Person's email address.
   * @param {string|null} name     Person's full name.
   * @param {string|null} company  Company name.
   * @returns {Promise<{linkedInUrl: string|null, serpVerified: boolean, errors: string[]}>}
   */
  async _runParallelDiscovery(email, name, company) {
    // Mark both discovery steps active simultaneously so the UI shows both
    // running at once rather than one waiting behind the other.
    this._notifyProgress('serp-discovery', 'active');
    this._notifyProgress('deep-lookup', 'active');

    const serpStart = Date.now();
    const deepStart = Date.now();

    /**
     * Wrap each layer so that:
     * - A missing LinkedIn URL is treated as rejection (needed for Promise.any).
     * - Progress notifications are emitted for the winning and losing steps.
     * - Errors from the layer are caught and re-thrown so Promise.any sees them.
     *
     * @param {'serp'|'deep-lookup'} kind
     * @param {Promise<{success:boolean,linkedInUrl?:string,error?:string}>} layerPromise
     * @param {number} timeoutMs
     * @returns {Promise<{linkedInUrl:string, source:string, kind:string}>}
     */
    const makeRace = (kind, layerPromise, timeoutMs, startedAt) => {
      return withTimeout(layerPromise, timeoutMs, kind)
        .then((result) => {
          const elapsedMs = Date.now() - startedAt;
          if (result.success && result.linkedInUrl) {
            // This layer won — mark completed.
            const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
            this._notifyProgress(stepId, 'completed');
            if (this._logBuffer) {
              this._logBuffer.info('Waterfall', `${kind} completed in ${elapsedMs}ms`);
            }
            console.log(LOG_PREFIX, `Layer ${kind} completed in ${elapsedMs}ms`);
            return { linkedInUrl: result.linkedInUrl, source: result.source, kind };
          }
          // Layer returned but found nothing — treat as a rejection so
          // Promise.any can try the other branch.
          const errMsg = result.error || `${kind} found no LinkedIn URL`;
          const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
          this._notifyProgress(stepId, 'failed');
          if (this._logBuffer) {
            this._logBuffer.error('Waterfall', `${kind} failed in ${elapsedMs}ms: ${errMsg}`);
          }
          console.warn(LOG_PREFIX, `Layer ${kind} failed in ${elapsedMs}ms: ${errMsg}`);
          throw new Error(errMsg);
        })
        .catch((err) => {
          // Re-emit failed status if not already set by the .then() branch above
          // (e.g. timeout path). Guard with a double-mark — _notifyProgress is
          // idempotent for same status, so this is safe.
          const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
          const currentStatus = this._stepsState.find(s => s.id === stepId)?.status;
          if (currentStatus !== 'failed') {
            const elapsedMs = Date.now() - startedAt;
            this._notifyProgress(stepId, 'failed');
            if (this._logBuffer) {
              this._logBuffer.error('Waterfall', `${kind} failed in ${elapsedMs}ms: ${err.message}`);
            }
            console.warn(LOG_PREFIX, `Layer ${kind} failed in ${elapsedMs}ms: ${err.message}`);
          }
          throw err;
        });
    };

    const serpPromise = makeRace(
      'serp',
      this._layerSerpDiscovery(email, name, company),
      LAYER_TIMEOUTS.serpDiscovery,
      serpStart
    );

    const deepPromise = makeRace(
      'deep-lookup',
      this._layerDeepLookup(email, name, company),
      LAYER_TIMEOUTS.deepLookup,
      deepStart
    );

    // Promise.any resolves with the first fulfilled value.
    // If both reject the AggregateError carries both error messages.
    try {
      const winner = await Promise.any([serpPromise, deepPromise]);

      // The loser is still running in background — mark it skipped once it
      // settles so the UI doesn't stay 'active' indefinitely.
      const loserKind   = winner.kind === 'serp' ? 'deep-lookup' : 'serp';
      const loserStepId = loserKind === 'serp' ? 'serp-discovery' : 'deep-lookup';
      const loserPromise = winner.kind === 'serp' ? deepPromise : serpPromise;

      loserPromise.catch(() => {
        // Already marked failed inside makeRace — nothing more to do.
      }).finally(() => {
        const loserStatus = this._stepsState.find(s => s.id === loserStepId)?.status;
        if (loserStatus === 'active') {
          this._notifyProgress(loserStepId, 'skipped');
        }
      });

      return {
        linkedInUrl: winner.linkedInUrl,
        serpVerified: winner.kind === 'serp',
        errors: [],
      };
    } catch (aggregateErr) {
      // Both discovery layers failed. Collect error messages.
      const errors = aggregateErr.errors
        ? aggregateErr.errors.map(e => e?.message || String(e))
        : [aggregateErr.message];

      return { linkedInUrl: null, serpVerified: false, errors };
    }
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

    // ── Layers 2+3: Parallel SERP + Deep Lookup discovery ─────────────────
    // Both run concurrently; the first to find a LinkedIn URL wins.
    // Progress notifications for both steps are managed inside
    // _runParallelDiscovery so the UI reflects real-time status accurately.
    const discoveryResult = await this._runParallelDiscovery(email, name, company);
    const { linkedInUrl, serpVerified, errors: discoveryErrors } = discoveryResult;

    if (!linkedInUrl) {
      this._notifyProgress('linkedin-scraper', 'skipped');
      this._notifyProgress('filter-enrich', 'skipped');

      throw new Error(
        `All discovery layers failed for "${identifier}". Errors: ${discoveryErrors.join('; ')}`
      );
    }

    // ── Layer 4: LinkedIn Scraper → LinkedIn ID ───────────────────────────

    // Must scrape to get the LinkedIn ID needed for the Filter API.
    // Also provides base profile data used as scraper fallback.
    let linkedInId = null;
    let scraperProfiles = null;

    {
      const scraperResult = await this._runLayer(
        'linkedin-scraper', 'linkedin-scraper',
        () => this._layerLinkedInScraper(linkedInUrl),
        LAYER_TIMEOUTS.linkedInScraper
      );

      if (scraperResult.success && scraperResult.linkedInId) {
        linkedInId = scraperResult.linkedInId;
        scraperProfiles = scraperResult.profiles;

        // Emit interim result immediately — the side panel can render a card
        // now without waiting for the slower Filter API (Layer 5).
        if (scraperResult.profiles?.length) {
          const interimData = pickBestProfile(
            scraperResult.profiles,
            name,
            'scraper',
            { email, serpVerified }
          );
          if (interimData && typeof this.onInterimResult === 'function') {
            try { this.onInterimResult(interimData); } catch (_) { /* swallow */ }
          }
        }
      } else {
        // Can't get LinkedIn ID — skip filter, try to use scraper data.
        this._notifyProgress('filter-enrich', 'skipped');

        if (scraperResult.success && scraperResult.profiles?.length) {
          const data = await this._finalise(
            { profiles: scraperResult.profiles, source: 'scraper' },
            name, email, cacheKey, identifier,
            { serpVerified }
          );
          if (data) return data;
        }

        throw new Error(
          `Could not determine LinkedIn ID for "${identifier}"`
        );
      }
    }

    // ── Layer 5: Filter API + Deep Lookup Company Intel (parallel) ────────
    //
    // Run both enrichment sources concurrently:
    //   a) Filter API — query enriched LinkedIn data by LinkedIn ID.
    //   b) Deep Lookup Company Intel — search the public web for company
    //      details (products, funding, news, tech stack).
    //
    // The Filter result is the primary data source. Company intel
    // supplements it with fields that LinkedIn doesn't carry.

    // Extract company/title from interim scraper data for the company intel spec.
    const interimCompany = scraperProfiles?.[0]?.current_company?.name
      || scraperProfiles?.[0]?.current_company_name || company;
    const interimTitle = scraperProfiles?.[0]?.current_company?.title
      || scraperProfiles?.[0]?.position || null;

    const [filterResult, companyIntel, serpCompanyInfo] = await Promise.all([
      this._runLayer(
        'filter-enrich', 'filter-enrich',
        () => this._layerFilterEnrich(linkedInId),
        LAYER_TIMEOUTS.filterEnrich
      ),
      // Company intel via Deep Lookup — fire and forget (non-fatal).
      deepLookupCompanyIntel(
        interimCompany, name, interimTitle, linkedInUrl, this._apiToken
      ).catch((err) => {
        console.warn(LOG_PREFIX, 'Company intel failed (non-fatal):', err.message);
        if (this._logBuffer) {
          this._logBuffer.warn('Waterfall', 'Company intel failed: ' + err.message);
        }
        return null;
      }),
      // SERP company info — searches Google for company context (non-fatal).
      serpSearchCompanyInfo(
        interimCompany, this._apiToken, this._customerId
      ).catch((err) => {
        console.warn(LOG_PREFIX, 'SERP company search failed (non-fatal):', err.message);
        return null;
      }),
    ]);

    if (filterResult.success && filterResult.profiles?.length) {
      // Use filter data as primary, merge with scraper data if available.
      const data = await this._finalise(
        {
          profiles: filterResult.profiles,
          scraperProfiles,
          companyIntel,
          serpCompanyInfo,
          source: 'filter',
        },
        name, email, cacheKey, identifier,
        { serpVerified }
      );
      if (data) return data;
    }

    // Filter failed or returned thin data — fall back to scraper profiles.
    if (scraperProfiles && scraperProfiles.length) {
      console.log(LOG_PREFIX, 'Filter failed, falling back to scraper data');
      const data = await this._finalise(
        { profiles: scraperProfiles, companyIntel, serpCompanyInfo, source: 'scraper' },
        name, email, cacheKey, identifier,
        { serpVerified }
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
    const { profiles, scraperProfiles, companyIntel, serpCompanyInfo, source } = layerResult;

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
    if (scraperProfiles?.length && source === 'filter') {
      const merged = mergeBusinessEnrichedData(personData, scraperProfiles[0]);
      Object.assign(personData, merged);
    }

    // Merge Deep Lookup company intelligence from the public web.
    if (companyIntel && typeof companyIntel === 'object') {
      this._mergeCompanyIntel(personData, companyIntel);
    }

    // Merge SERP company info (lower priority — fills what Deep Lookup missed).
    if (serpCompanyInfo && typeof serpCompanyInfo === 'object') {
      this._mergeCompanyIntel(personData, serpCompanyInfo);
    }

    // Fallback: if experience is empty but we have a LinkedIn URL, try deepLookupEnrich.
    if ((!personData.experience || personData.experience.length === 0) && personData.linkedinUrl) {
      try {
        console.log(LOG_PREFIX, 'Experience missing — trying Deep Lookup enrich for:', personData.name);
        const enrichData = await deepLookupEnrich(
          personData.linkedinUrl,
          personData.linkedInId || null,
          personData.name,
          this._apiToken
        );
        if (enrichData) {
          this._mergeEnrichData(personData, enrichData);
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Deep Lookup enrich fallback failed:', err.message);
      }
    }

    // Re-derive ICP after all merges so badges reflect final data.
    const { deriveIcpProfile } = await import('./response-normalizer.js');
    personData.icp = deriveIcpProfile(personData);

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

  /**
   * Merge Deep Lookup company intelligence into PersonData.
   * Only fills gaps — never overwrites populated fields.
   *
   * @param {Object} personData   Normalized PersonData (mutated in place).
   * @param {Object} companyIntel Raw company intel from Deep Lookup.
   */
  _mergeCompanyIntel(personData, companyIntel) {
    const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    if (!personData.companyDescription) {
      personData.companyDescription = str(companyIntel.company_description) || null;
    }
    if (!personData.companyIndustry) {
      personData.companyIndustry = str(companyIntel.company_industry) || null;
    }

    // New fields from public web — always set if available (not in LinkedIn data).
    if (!personData.companyWebsite) {
      personData.companyWebsite = str(companyIntel.company_website) || null;
    }
    if (!personData.companyFounded) {
      personData.companyFounded = str(companyIntel.company_founded_year) || null;
    }
    if (!personData.companyHeadquarters) {
      personData.companyHeadquarters = str(companyIntel.company_headquarters) || null;
    }
    if (!personData.companyFunding) {
      personData.companyFunding = str(companyIntel.company_funding) || null;
    }
    if (!personData.companyProducts) {
      personData.companyProducts = str(companyIntel.products_services) || null;
    }
    if (!personData.companyTechnologies) {
      personData.companyTechnologies = str(companyIntel.technologies) || null;
    }
    if (!personData.recentNews) {
      personData.recentNews = str(companyIntel.recent_news) || null;
    }

    console.log(LOG_PREFIX, 'Merged company intel for:', personData.currentCompany,
      '— fields:', Object.keys(companyIntel).filter(k => str(companyIntel[k])).join(', '));
  }

  /**
   * Merge Deep Lookup enrichment data (work experience, education, skills)
   * into PersonData. Only fills gaps — never overwrites populated fields.
   */
  _mergeEnrichData(personData, enrichData) {
    const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : null;

    // Current position fallback.
    if (!personData.currentTitle && enrichData.current_position) {
      personData.currentTitle = str(enrichData.current_position);
    }

    // Parse work experience text into structured entries.
    if ((!personData.experience || personData.experience.length === 0) && enrichData.work_experience) {
      personData.experience = this._parseWorkExperienceText(enrichData.work_experience);
    }

    // Parse education text into structured entries.
    if ((!personData.education || personData.education.length === 0) && enrichData.education) {
      personData.education = this._parseEducationText(enrichData.education);
    }

    // Skills — merge if we got them.
    if (enrichData.skills && !personData.skills?.length) {
      personData.skills = enrichData.skills.split(',').map(s => s.trim()).filter(Boolean);
    }

    console.log(LOG_PREFIX, 'Merged enrich data — experience:', personData.experience?.length,
      'education:', personData.education?.length, 'skills:', personData.skills?.length);
  }

  /**
   * Best-effort parse of work experience prose into structured array.
   * Deep Lookup returns free text like "Company A - Title (2020-2023)\nCompany B - Title..."
   */
  _parseWorkExperienceText(text) {
    if (!text || typeof text !== 'string') return [];
    const entries = [];
    // Split on newlines or semicolons.
    const lines = text.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Try to extract: "Company - Title (dates)" or "Title at Company (dates)"
      const atMatch = line.match(/^(.+?)\s+at\s+(.+?)(?:\s*[\(,]\s*(.+?)[\)]?)?$/i);
      const dashMatch = line.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s*[\(,]\s*(.+?)[\)]?)?$/i);
      if (atMatch) {
        entries.push({
          title: atMatch[1].trim(), company: atMatch[2].trim(),
          companyLogoUrl: null, startDate: atMatch[3]?.trim() || null,
          endDate: null, location: null, description: null,
        });
      } else if (dashMatch) {
        entries.push({
          title: dashMatch[2].trim(), company: dashMatch[1].trim(),
          companyLogoUrl: null, startDate: dashMatch[3]?.trim() || null,
          endDate: null, location: null, description: null,
        });
      } else if (line.length > 5) {
        entries.push({
          title: line, company: null, companyLogoUrl: null,
          startDate: null, endDate: null, location: null, description: null,
        });
      }
    }
    return entries;
  }

  /**
   * Best-effort parse of education prose into structured array.
   */
  _parseEducationText(text) {
    if (!text || typeof text !== 'string') return [];
    const entries = [];
    const lines = text.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(.+?)(?:\s*[-–—,]\s*(.+?))?(?:\s*[\(]\s*(.+?)[\)])?$/);
      if (match) {
        entries.push({
          institution: match[1].trim(),
          degree: match[2]?.trim() || null,
          field: null,
          startYear: null,
          endYear: match[3]?.trim() || null,
          logoUrl: null,
        });
      }
    }
    return entries;
  }
}
