// PreMeet – Waterfall Fetch Orchestrator
// Executes a deterministic multi-layer lookup cascade for a given person.

import { scrapeByLinkedInUrl, pollSnapshotUntilReady, downloadSnapshot, extractLinkedInId, extractLinkedInIdFromUrl } from './data-scraper';
import { deepLookupFindLinkedIn, deepLookupEnrich, deepLookupCompanyIntel } from './deep-lookup';
import { serpFindLinkedInUrl, serpSearchCompanyInfo } from './serp-api';
import { filterByLinkedInId } from './data-filter';
import { pickBestProfile, mergeBusinessEnrichedData, deriveIcpProfile } from './response-normalizer';
import type { CacheManager } from './cache-manager';
import { EnrichmentCacheService } from '../../lib/enrichment-cache';
import type { PersonData, ProgressPayload, StepState, WaterfallPayload, SearchResult, CompanyInfo, ExperienceEntry, EducationEntry } from './types';

const LOG_PREFIX = '[PreMeet][Waterfall]';

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — profile data changes infrequently

const PIPELINE_STEPS: Array<Omit<StepState, 'status'>> = [
  { id: 'cache', label: 'Checking cache...', icon: 'cache', percent: 5 },
  { id: 'serp-discovery', label: 'Searching Google for LinkedIn...', icon: 'search', percent: 20 },
  { id: 'deep-lookup', label: 'Deep lookup by email...', icon: 'magnifier', percent: 40 },
  { id: 'linkedin-scraper', label: 'Scraping LinkedIn profile...', icon: 'linkedin', percent: 60 },
  { id: 'filter-enrich', label: 'Fetching enriched data...', icon: 'filter', percent: 90 },
];

const SEARCH_STEPS: Array<Omit<StepState, 'status'>> = [
  { id: 'cache', label: 'Checking cache...', icon: 'cache', percent: 10 },
  { id: 'serp-discovery', label: 'Searching Google for LinkedIn...', icon: 'search', percent: 50 },
  { id: 'deep-lookup', label: 'Deep lookup by email...', icon: 'magnifier', percent: 90 },
];

const ENRICH_STEPS: Array<Omit<StepState, 'status'>> = [
  { id: 'linkedin-scraper', label: 'Scraping LinkedIn profile...', icon: 'linkedin', percent: 40 },
  { id: 'filter-enrich', label: 'Fetching enriched data...', icon: 'filter', percent: 90 },
];

const LAYER_TIMEOUTS = {
  serpDiscovery: 35_000,   // POST + poll loop; matches reference implementation
  deepLookup: 90_000,
  linkedInScraper: 60_000,
  filterEnrich: 130_000,   // Matches reference implementation
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gravatarAvatarUrl(email: string): Promise<string | null> {
  if (!email || typeof email !== 'string') return null;
  try {
    const normalised = email.trim().toLowerCase();
    const encoded = new TextEncoder().encode(normalised);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `https://www.gravatar.com/avatar/${hashHex}?d=404&s=200`;
  } catch (err) {
    console.warn(LOG_PREFIX, 'gravatarAvatarUrl failed:', (err as Error).message);
    return null;
  }
}

export function normaliseCacheKey(value: string): string {
  return (value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
}

/** Extract LinkedIn username slug from a full URL for use as a canonical cache key. */
function linkedInSlug(url: string): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase().replace(/\/$/, '') : null;
}

/** Build the canonical LinkedIn alias cache key. */
function linkedInAliasKey(url: string): string | null {
  const slug = linkedInSlug(url);
  return slug ? `person_li_${slug}` : null;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  if (!fullName || !fullName.trim()) return { firstName: '', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function withTimeout<T>(promise: Promise<T>, ms: number, layerName: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[${layerName}] timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── Layer Result Types ──────────────────────────────────────────────────────

interface CacheLayerResult {
  success: boolean;
  _cachedData?: PersonData;
}

interface DiscoveryLayerResult {
  success: boolean;
  linkedInUrl?: string;
  source?: string;
  error?: string;
}

interface ScraperLayerResult {
  success: boolean;
  profiles?: Array<Record<string, unknown>>;
  linkedInId?: string | null;
  linkedInUrl?: string;
  source?: string;
  error?: string;
}

interface FilterLayerResult {
  success: boolean;
  profiles?: Array<Record<string, unknown>>;
  source?: string;
  error?: string;
}

interface LayerRunResult<T> extends Record<string, unknown> {
  success: boolean;
  error?: string;
  elapsedMs?: number;
}

interface LogBuffer {
  info(category: string, message: string): void;
  error(category: string, message: string): void;
  warn(category: string, message: string): void;
}

// ─── WaterfallOrchestrator ───────────────────────────────────────────────────

export class WaterfallOrchestrator {
  private _cache: CacheManager;
  private _serverCache: EnrichmentCacheService;
  private _logBuffer: LogBuffer | null;
  private _personName: string = '';
  private _stepsState: StepState[];

  onProgress: ((payload: ProgressPayload) => void) | null = null;
  onInterimResult: ((data: PersonData) => void) | null = null;

  constructor(cacheManager: CacheManager, logBuffer?: LogBuffer | null) {
    this._cache = cacheManager;
    this._serverCache = new EnrichmentCacheService();
    this._logBuffer = logBuffer || null;
    this._stepsState = PIPELINE_STEPS.map((s) => ({ ...s, status: 'pending' as const }));
  }

  private _notifyProgress(stepId: string, status: StepState['status']): void {
    const stepIndex = this._stepsState.findIndex((s) => s.id === stepId);
    if (stepIndex >= 0) {
      this._stepsState[stepIndex].status = status;
    }

    const activeStep = this._stepsState.find((s) => s.id === stepId);
    const payload: ProgressPayload = {
      label: activeStep?.label || '',
      percent: activeStep?.percent || 0,
      step: stepIndex + 1,
      totalSteps: this._stepsState.length,
      stepId,
      stepStatus: status,
      personName: this._personName,
      stepsState: this._stepsState.map((s) => ({ ...s })),
    };

    if (typeof this.onProgress !== 'function') return;
    try {
      Promise.resolve(this.onProgress(payload)).catch(() => {});
    } catch {
      // swallow
    }
  }

  private async _runLayer<T extends { success: boolean; error?: string }>(
    layerName: string,
    stepId: string,
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T & { elapsedMs: number }> {
    this._notifyProgress(stepId, 'active');
    console.log(LOG_PREFIX, `Layer: ${layerName}`);
    const start = Date.now();

    try {
      const result = await withTimeout(fn(), timeoutMs, layerName);
      const elapsedMs = Date.now() - start;
      const status = result.success ? 'completed' : 'failed';
      this._notifyProgress(stepId, status);
      this._logBuffer?.info('Waterfall', `${layerName} ${status} in ${elapsedMs}ms`);
      console.log(LOG_PREFIX, `Layer ${layerName} ${status} in ${elapsedMs}ms`);
      return { ...result, elapsedMs };
    } catch (err) {
      const elapsedMs = Date.now() - start;
      this._notifyProgress(stepId, 'failed');
      this._logBuffer?.error('Waterfall', `${layerName} failed in ${elapsedMs}ms: ${(err as Error).message}`);
      console.warn(LOG_PREFIX, `Layer ${layerName} failed in ${elapsedMs}ms: ${(err as Error).message}`);
      return { success: false, error: (err as Error).message, elapsedMs } as T & { elapsedMs: number };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _toSearchResult(person: PersonData): SearchResult {
    return {
      name: person.name,
      firstName: person.firstName,
      lastName: person.lastName,
      avatarUrl: person.avatarUrl,
      currentTitle: person.currentTitle,
      currentCompany: person.currentCompany,
      location: person.location,
      connections: person.connections,
      followers: person.followers,
      linkedinUrl: person.linkedinUrl,
      confidence: person._confidence,
      confidenceScore: person._confidenceScore,
    };
  }

  // ── Layer implementations ──────────────────────────────────────────────────

  private async _layerCache(cacheKey: string, knownLinkedInUrl?: string): Promise<CacheLayerResult> {
    // Check Chrome local storage first (fastest, same-device)
    const localCached = await this._cache.get<PersonData>(cacheKey);
    if (localCached) {
      console.log(LOG_PREFIX, 'Local cache hit for:', cacheKey);
      return { success: true, _cachedData: localCached };
    }

    // Also check LinkedIn alias key locally (catches same person looked up via different email/name)
    const aliasKey = knownLinkedInUrl ? linkedInAliasKey(knownLinkedInUrl) : null;
    if (aliasKey) {
      const aliasCached = await this._cache.get<PersonData>(aliasKey);
      if (aliasCached) {
        // Backfill primary key so future lookups are instant
        await this._cache.set(cacheKey, aliasCached, CACHE_TTL_MS).catch(() => {});
        console.log(LOG_PREFIX, 'Local alias cache hit for:', aliasKey);
        return { success: true, _cachedData: aliasCached };
      }
    }

    // Fall back to server cache (shared across devices, deduped)
    const keysToCheck = aliasKey ? [cacheKey, aliasKey] : [cacheKey];
    for (const key of keysToCheck) {
      try {
        const serverResult = await this._serverCache.get('person', key);
        if (serverResult.hit && serverResult.data) {
          const personData = serverResult.data as unknown as PersonData;
          // Backfill local cache so next lookup is instant
          await this._cache.set(cacheKey, personData, CACHE_TTL_MS).catch(() => {});
          console.log(LOG_PREFIX, `Server cache hit for: ${key}${key !== cacheKey ? ' (alias)' : ''}`);
          return { success: true, _cachedData: personData };
        }
      } catch (err) {
        console.warn(LOG_PREFIX, `Server cache lookup failed for ${key} (non-fatal):`, (err as Error).message);
      }
    }

    return { success: false };
  }

  private async _layerSerpDiscovery(email: string, name: string, company: string): Promise<DiscoveryLayerResult> {
    // Fire email and name queries in parallel for faster discovery
    const queries: Array<{ label: string; query: string }> = [];

    if (email && email.includes('@')) {
      queries.push({ label: 'email', query: email });
    }
    if (name) {
      queries.push({ label: 'name', query: company ? `${name} ${company}` : name });
    }

    if (queries.length === 0) {
      return { success: false, error: 'SERP: no email or name to search' };
    }

    console.log(LOG_PREFIX, `SERP: parallel search with ${queries.length} queries`);

    // Race all queries — first one to find a LinkedIn URL wins
    const promises = queries.map(({ label, query }) =>
      serpFindLinkedInUrl(query).then((url) => {
        if (url) return url;
        throw new Error(`SERP ${label} query found no LinkedIn URL`);
      }),
    );

    try {
      const linkedInUrl = await Promise.any(promises);
      return { success: true, linkedInUrl, source: 'serp' };
    } catch (aggErr) {
      const details = (aggErr as AggregateError).errors
        ? (aggErr as AggregateError).errors.map((e: unknown) => (e as Error)?.message || String(e)).join('; ')
        : (aggErr as Error).message;
      console.warn(LOG_PREFIX, 'SERP all queries failed:', details);
      return { success: false, error: `SERP found no LinkedIn URL from any query: ${details}` };
    }
  }

  private async _layerDeepLookup(email: string, name: string, company: string): Promise<DiscoveryLayerResult> {
    const result = await deepLookupFindLinkedIn(email, name, company);
    if (!result.linkedInUrl) return { success: false, error: 'Deep Lookup found no LinkedIn URL' };
    return { success: true, linkedInUrl: result.linkedInUrl, source: 'deep-lookup' };
  }

  private async _layerLinkedInScraper(linkedInUrl: string): Promise<ScraperLayerResult> {
    const scrapeResult = await scrapeByLinkedInUrl(linkedInUrl);

    let profiles: Array<Record<string, unknown>> = [];

    if (scrapeResult.mode === 'direct') {
      profiles = scrapeResult.profiles || [];
    } else if (scrapeResult.mode === 'snapshot' && scrapeResult.snapshotId) {
      await pollSnapshotUntilReady(scrapeResult.snapshotId);
      profiles = await downloadSnapshot(scrapeResult.snapshotId);
    }

    if (!profiles.length) return { success: false, error: 'LinkedIn Scraper returned no profiles' };

    const profile = profiles[0];
    const linkedInId = extractLinkedInId(profile, linkedInUrl);

    console.log(LOG_PREFIX, 'LinkedIn Scraper profile fields:', {
      id: profile?.id,
      linkedin_id: profile?.linkedin_id,
      linkedin_num_id: profile?.linkedin_num_id,
      name: profile?.name,
      url: profile?.url,
    });

    return { success: true, profiles, linkedInId, linkedInUrl, source: 'scraper' };
  }

  private async _layerFilterEnrich(linkedInId: string | null): Promise<FilterLayerResult> {
    if (!linkedInId) return { success: false, error: 'No LinkedIn ID for Filter API' };
    const profiles = await filterByLinkedInId(linkedInId);
    if (!profiles || profiles.length === 0) return { success: false, error: 'Filter API returned no results' };
    return { success: true, profiles, source: 'filter' };
  }

  // ── Parallel discovery ────────────────────────────────────────────────────

  private async _runParallelDiscovery(
    email: string,
    name: string,
    company: string,
  ): Promise<{ linkedInUrl: string | null; serpVerified: boolean; errors: string[] }> {
    this._notifyProgress('serp-discovery', 'active');
    this._notifyProgress('deep-lookup', 'active');

    const serpStart = Date.now();
    const deepStart = Date.now();

    const makeRace = (
      kind: 'serp' | 'deep-lookup',
      layerPromise: Promise<DiscoveryLayerResult>,
      timeoutMs: number,
      startedAt: number,
    ): Promise<{ linkedInUrl: string; source: string; kind: string }> => {
      return withTimeout(layerPromise, timeoutMs, kind)
        .then((result) => {
          const elapsedMs = Date.now() - startedAt;
          if (result.success && result.linkedInUrl) {
            const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
            this._notifyProgress(stepId, 'completed');
            this._logBuffer?.info('Waterfall', `${kind} completed in ${elapsedMs}ms`);
            console.log(LOG_PREFIX, `Layer ${kind} completed in ${elapsedMs}ms`);
            return { linkedInUrl: result.linkedInUrl, source: result.source!, kind };
          }
          const errMsg = result.error || `${kind} found no LinkedIn URL`;
          const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
          this._notifyProgress(stepId, 'failed');
          this._logBuffer?.error('Waterfall', `${kind} failed in ${elapsedMs}ms: ${errMsg}`);
          console.warn(LOG_PREFIX, `Layer ${kind} failed in ${elapsedMs}ms: ${errMsg}`);
          throw new Error(errMsg);
        })
        .catch((err) => {
          const stepId = kind === 'serp' ? 'serp-discovery' : 'deep-lookup';
          const currentStatus = this._stepsState.find((s) => s.id === stepId)?.status;
          if (currentStatus !== 'failed') {
            const elapsedMs = Date.now() - startedAt;
            this._notifyProgress(stepId, 'failed');
            this._logBuffer?.error('Waterfall', `${kind} failed in ${elapsedMs}ms: ${(err as Error).message}`);
            console.warn(LOG_PREFIX, `Layer ${kind} failed in ${elapsedMs}ms: ${(err as Error).message}`);
          }
          throw err;
        });
    };

    const serpPromise = makeRace('serp', this._layerSerpDiscovery(email, name, company), LAYER_TIMEOUTS.serpDiscovery, serpStart);
    const deepPromise = makeRace(
      'deep-lookup',
      this._layerDeepLookup(email, name, company),
      LAYER_TIMEOUTS.deepLookup,
      deepStart,
    );

    try {
      const winner = await Promise.any([serpPromise, deepPromise]);

      const loserKind = winner.kind === 'serp' ? 'deep-lookup' : 'serp';
      const loserStepId = loserKind === 'serp' ? 'serp-discovery' : 'deep-lookup';
      const loserPromise = winner.kind === 'serp' ? deepPromise : serpPromise;

      loserPromise.catch(() => {}).finally(() => {
        const loserStatus = this._stepsState.find((s) => s.id === loserStepId)?.status;
        if (loserStatus === 'active') {
          this._notifyProgress(loserStepId, 'skipped');
        }
      });

      return { linkedInUrl: winner.linkedInUrl, serpVerified: winner.kind === 'serp', errors: [] };
    } catch (aggregateErr) {
      const errors = (aggregateErr as AggregateError).errors
        ? (aggregateErr as AggregateError).errors.map((e: unknown) => (e as Error)?.message || String(e))
        : [(aggregateErr as Error).message];
      return { linkedInUrl: null, serpVerified: false, errors };
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Phase A — Lightweight search. Runs cache + SERP/deep-lookup discovery only.
   * Returns a SearchResult with LinkedIn URL and basic identity info.
   * Does NOT consume credits.
   */
  async search(payload: WaterfallPayload): Promise<SearchResult> {
    const { name, email, company } = payload;
    const identifier = name || email || 'unknown';
    const cacheKey = `person_${normaliseCacheKey(email || name || identifier)}`;

    this._personName = name || email || 'unknown';
    this._stepsState = SEARCH_STEPS.map((s) => ({ ...s, status: 'pending' as const }));

    console.log(LOG_PREFIX, `Search started for: "${identifier}"`);

    // Layer 1: Cache — if we have full PersonData cached, extract a SearchResult
    const cacheResult = await this._runLayer('cache', 'cache', () => this._layerCache(cacheKey), 500);
    if (cacheResult.success && (cacheResult as CacheLayerResult & { elapsedMs: number })._cachedData) {
      console.log(LOG_PREFIX, `Search cache hit for "${identifier}"`);
      for (const step of this._stepsState) {
        if (step.status === 'pending') this._notifyProgress(step.id, 'skipped');
      }
      const cached = (cacheResult as CacheLayerResult & { elapsedMs: number })._cachedData!;
      return this._toSearchResult(cached);
    }

    // Layers 2+3: Parallel SERP + Deep Lookup discovery
    const discoveryResult = await this._runParallelDiscovery(email, name, company);
    const { linkedInUrl, errors: discoveryErrors } = discoveryResult;

    if (!linkedInUrl) {
      throw new Error(`All discovery layers failed for "${identifier}". Errors: ${discoveryErrors.join('; ')}`);
    }

    const { firstName, lastName } = splitName(name);

    const gravatarUrl = email ? await gravatarAvatarUrl(email) : null;

    return {
      name: name || email || 'unknown',
      firstName,
      lastName,
      avatarUrl: gravatarUrl,
      currentTitle: null,
      currentCompany: company || null,
      location: null,
      connections: null,
      followers: null,
      linkedinUrl: linkedInUrl,
      confidence: 'partial',
      confidenceScore: linkedInUrl ? 40 : 10,
    };
  }

  /**
   * Phase B — Full enrichment from a known LinkedIn URL.
   * Runs LinkedIn scraper + filter API + company intel ALL in parallel.
   * The LinkedIn ID is extracted directly from the URL so filter can start
   * immediately without waiting for the scraper to finish.
   * Consumes 1 credit (caller is responsible for credit deduction).
   */
  async enrich(payload: WaterfallPayload & { linkedInUrl: string }): Promise<PersonData> {
    const { name, email, company, linkedInUrl } = payload;
    const identifier = name || email || 'unknown';
    const cacheKey = `person_${normaliseCacheKey(email || name || identifier)}`;

    this._personName = name || email || 'unknown';
    this._stepsState = ENRICH_STEPS.map((s) => ({ ...s, status: 'pending' as const }));

    console.log(LOG_PREFIX, `Enrich started for: "${identifier}" (LinkedIn: ${linkedInUrl})`);

    // Extract LinkedIn ID from URL upfront so filter can run in parallel with scraper
    const urlLinkedInId = extractLinkedInIdFromUrl(linkedInUrl);
    if (!urlLinkedInId) {
      console.warn(LOG_PREFIX, `Could not extract LinkedIn ID from URL: ${linkedInUrl}`);
    }

    // Run scraper + filter + company intel ALL in parallel
    const enrichStart = Date.now();

    const scraperPromise = this._runLayer(
      'linkedin-scraper',
      'linkedin-scraper',
      () => this._layerLinkedInScraper(linkedInUrl),
      LAYER_TIMEOUTS.linkedInScraper,
    );

    const filterPromise = urlLinkedInId
      ? this._runLayer('filter-enrich', 'filter-enrich', () => this._layerFilterEnrich(urlLinkedInId), LAYER_TIMEOUTS.filterEnrich)
      : Promise.resolve({ success: false, error: 'No LinkedIn ID extractable from URL', elapsedMs: 0 } as FilterLayerResult & { elapsedMs: number });

    const companyIntelPromise = deepLookupCompanyIntel(
      String(company || ''),
      name,
      null,
      linkedInUrl,
    ).catch((err) => {
      console.warn(LOG_PREFIX, 'Company intel failed (non-fatal):', (err as Error).message);
      this._logBuffer?.warn('Waterfall', 'Company intel failed: ' + (err as Error).message);
      return null;
    });

    const serpCompanyPromise = serpSearchCompanyInfo(String(company || '')).catch((err) => {
      console.warn(LOG_PREFIX, 'SERP company search failed (non-fatal):', (err as Error).message);
      return null;
    });

    // Fire interim result from scraper as soon as it arrives (don't wait for filter)
    const scraperSettled = scraperPromise.then((result) => {
      const sr = result as ScraperLayerResult & { elapsedMs: number };
      if (sr.success && sr.profiles?.length) {
        const interimData = pickBestProfile(sr.profiles, name, 'scraper', { email, serpVerified: false });
        if (interimData && typeof this.onInterimResult === 'function') {
          try { this.onInterimResult(interimData); } catch { /* swallow */ }
        }
      }
      return sr;
    });

    // Wait for all layers to complete
    const [scraperResult, filterResult, companyIntel, serpCompanyInfo] = await Promise.all([
      scraperSettled,
      filterPromise,
      companyIntelPromise,
      serpCompanyPromise,
    ]);

    const sr = scraperResult as ScraperLayerResult & { elapsedMs: number };
    const fr = filterResult as FilterLayerResult & { elapsedMs: number };
    const scraperProfiles = sr.success ? (sr.profiles || null) : null;

    const totalMs = Date.now() - enrichStart;
    console.log(LOG_PREFIX, `All enrichment layers completed in ${totalMs}ms (scraper: ${sr.elapsedMs}ms, filter: ${fr.elapsedMs}ms)`);

    // If filter couldn't start because no URL-based ID, try with scraper-extracted ID
    if (!fr.success && !urlLinkedInId && sr.success && sr.linkedInId) {
      console.log(LOG_PREFIX, 'Retrying filter with scraper-extracted LinkedIn ID:', sr.linkedInId);
      const retryFilter = await this._runLayer(
        'filter-enrich',
        'filter-enrich',
        () => this._layerFilterEnrich(sr.linkedInId!),
        LAYER_TIMEOUTS.filterEnrich,
      );
      const retryFr = retryFilter as FilterLayerResult & { elapsedMs: number };
      if (retryFr.success && retryFr.profiles?.length) {
        const data = await this._finalise(
          { profiles: retryFr.profiles, scraperProfiles: scraperProfiles || undefined, companyIntel, serpCompanyInfo, source: 'filter' as const },
          name, email, cacheKey, identifier, { serpVerified: false },
        );
        if (data) return data;
      }
    }

    // Prefer filter data (richer), fall back to scraper
    if (fr.success && fr.profiles?.length) {
      const data = await this._finalise(
        {
          profiles: fr.profiles,
          scraperProfiles: scraperProfiles || undefined,
          companyIntel,
          serpCompanyInfo,
          source: 'filter' as const,
        },
        name,
        email,
        cacheKey,
        identifier,
        { serpVerified: false },
      );
      if (data) return data;
    }

    if (scraperProfiles && scraperProfiles.length) {
      console.log(LOG_PREFIX, 'Filter failed, falling back to scraper data');
      const data = await this._finalise(
        { profiles: scraperProfiles, companyIntel, serpCompanyInfo, source: 'scraper' as const },
        name,
        email,
        cacheKey,
        identifier,
        { serpVerified: false },
      );
      if (data) return data;
    }

    // Build detailed error message showing which layers failed
    const layerErrors: string[] = [];
    if (!sr.success) layerErrors.push(`scraper: ${sr.error || 'unknown error'}`);
    if (!fr.success) layerErrors.push(`filter: ${fr.error || 'unknown error'}`);
    throw new Error(`All enrichment layers failed for "${identifier}" [${layerErrors.join('; ')}]`);
  }

  async fetch(payload: WaterfallPayload): Promise<PersonData> {
    const { name, email, company } = payload;
    const identifier = name || email || 'unknown';
    const cacheKey = `person_${normaliseCacheKey(email || name || identifier)}`;

    this._personName = name || email || 'unknown';
    this._stepsState = PIPELINE_STEPS.map((s) => ({ ...s, status: 'pending' as const }));

    console.log(LOG_PREFIX, `Waterfall started for: "${identifier}"`);

    // Layer 1: Cache
    const cacheResult = await this._runLayer('cache', 'cache', () => this._layerCache(cacheKey), 500);
    if (cacheResult.success && (cacheResult as CacheLayerResult & { elapsedMs: number })._cachedData) {
      console.log(LOG_PREFIX, `Cache hit for "${identifier}"`);
      for (const step of this._stepsState) {
        if (step.status === 'pending') this._notifyProgress(step.id, 'skipped');
      }
      return (cacheResult as CacheLayerResult & { elapsedMs: number })._cachedData!;
    }

    // Layers 2+3: Parallel SERP + Deep Lookup discovery
    const discoveryResult = await this._runParallelDiscovery(email, name, company);
    const { linkedInUrl, serpVerified, errors: discoveryErrors } = discoveryResult;

    if (!linkedInUrl) {
      this._notifyProgress('linkedin-scraper', 'skipped');
      this._notifyProgress('filter-enrich', 'skipped');
      throw new Error(`All discovery layers failed for "${identifier}". Errors: ${discoveryErrors.join('; ')}`);
    }

    // Layers 4+5: Scraper + Filter + Company Intel (all parallel)
    // Extract LinkedIn ID from URL so filter can start immediately
    const urlLinkedInId = extractLinkedInIdFromUrl(linkedInUrl);

    const scraperPromise = this._runLayer(
      'linkedin-scraper',
      'linkedin-scraper',
      () => this._layerLinkedInScraper(linkedInUrl),
      LAYER_TIMEOUTS.linkedInScraper,
    );

    const filterPromise = urlLinkedInId
      ? this._runLayer('filter-enrich', 'filter-enrich', () => this._layerFilterEnrich(urlLinkedInId), LAYER_TIMEOUTS.filterEnrich)
      : Promise.resolve({ success: false, error: 'No LinkedIn ID from URL', elapsedMs: 0 } as FilterLayerResult & { elapsedMs: number });

    const companyIntelPromise = deepLookupCompanyIntel(
      String(company || ''),
      name,
      null,
      linkedInUrl,
    ).catch((err) => {
      console.warn(LOG_PREFIX, 'Company intel failed (non-fatal):', (err as Error).message);
      this._logBuffer?.warn('Waterfall', 'Company intel failed: ' + (err as Error).message);
      return null;
    });

    const serpCompanyPromise = serpSearchCompanyInfo(String(company || '')).catch((err) => {
      console.warn(LOG_PREFIX, 'SERP company search failed (non-fatal):', (err as Error).message);
      return null;
    });

    // Fire interim result from scraper as soon as it arrives
    const scraperSettled = scraperPromise.then((result) => {
      const sr = result as ScraperLayerResult & { elapsedMs: number };
      if (sr.success && sr.profiles?.length) {
        const interimData = pickBestProfile(sr.profiles, name, 'scraper', { email, serpVerified });
        if (interimData && typeof this.onInterimResult === 'function') {
          try { this.onInterimResult(interimData); } catch { /* swallow */ }
        }
      }
      return sr;
    });

    const [scraperResult, filterResult, companyIntel, serpCompanyInfo] = await Promise.all([
      scraperSettled,
      filterPromise,
      companyIntelPromise,
      serpCompanyPromise,
    ]);

    const sr = scraperResult as ScraperLayerResult & { elapsedMs: number };
    const fr = filterResult as FilterLayerResult & { elapsedMs: number };
    const scraperProfiles = sr.success ? (sr.profiles || null) : null;

    // If filter couldn't start because no URL-based ID, try with scraper-extracted ID
    if (!fr.success && !urlLinkedInId && sr.success && sr.linkedInId) {
      console.log(LOG_PREFIX, 'Retrying filter with scraper-extracted LinkedIn ID:', sr.linkedInId);
      const retryFilter = await this._runLayer(
        'filter-enrich',
        'filter-enrich',
        () => this._layerFilterEnrich(sr.linkedInId!),
        LAYER_TIMEOUTS.filterEnrich,
      );
      const retryFr = retryFilter as FilterLayerResult & { elapsedMs: number };
      if (retryFr.success && retryFr.profiles?.length) {
        const data = await this._finalise(
          { profiles: retryFr.profiles, scraperProfiles: scraperProfiles || undefined, companyIntel, serpCompanyInfo, source: 'filter' as const },
          name, email, cacheKey, identifier, { serpVerified },
        );
        if (data) return data;
      }
    }

    if (fr.success && fr.profiles?.length) {
      const data = await this._finalise(
        {
          profiles: fr.profiles,
          scraperProfiles: scraperProfiles || undefined,
          companyIntel,
          serpCompanyInfo,
          source: 'filter' as const,
        },
        name,
        email,
        cacheKey,
        identifier,
        { serpVerified },
      );
      if (data) return data;
    }

    if (scraperProfiles && scraperProfiles.length) {
      console.log(LOG_PREFIX, 'Filter failed, falling back to scraper data');
      const data = await this._finalise(
        { profiles: scraperProfiles, companyIntel, serpCompanyInfo, source: 'scraper' as const },
        name,
        email,
        cacheKey,
        identifier,
        { serpVerified },
      );
      if (data) return data;
    }

    const layerErrors: string[] = [];
    if (!sr.success) layerErrors.push(`scraper: ${sr.error || 'unknown'}`);
    if (!fr.success) layerErrors.push(`filter: ${fr.error || 'unknown'}`);
    throw new Error(`All enrichment layers failed for "${identifier}" [${layerErrors.join('; ')}]`);
  }

  private async _finalise(
    layerResult: {
      profiles: Array<Record<string, unknown>>;
      scraperProfiles?: Array<Record<string, unknown>>;
      companyIntel?: CompanyInfo | Record<string, unknown> | null;
      serpCompanyInfo?: CompanyInfo | Record<string, unknown> | null;
      source: PersonData['_source'];
    },
    name: string,
    email: string,
    cacheKey: string,
    identifier: string,
    context: { serpVerified: boolean } = { serpVerified: false },
  ): Promise<PersonData | null> {
    const { profiles, scraperProfiles, companyIntel, serpCompanyInfo, source } = layerResult;

    const personData = pickBestProfile(profiles, name, source, {
      email,
      serpVerified: context.serpVerified,
    });

    if (!personData) {
      console.log(LOG_PREFIX, `No usable profile for "${identifier}" from "${source}"`);
      return null;
    }

    if (personData.name === 'Unknown' && personData._confidence === 'low') {
      console.log(LOG_PREFIX, `Low-quality result for "${identifier}" — skipping`);
      return null;
    }

    if (scraperProfiles?.length && source === 'filter') {
      const merged = mergeBusinessEnrichedData(personData, scraperProfiles[0]);
      Object.assign(personData, merged);
    }

    if (companyIntel && typeof companyIntel === 'object') {
      this._mergeCompanyIntel(personData, companyIntel);
    }

    if (serpCompanyInfo && typeof serpCompanyInfo === 'object') {
      this._mergeCompanyIntel(personData, serpCompanyInfo);
    }

    if ((!personData.experience || personData.experience.length === 0) && personData.linkedinUrl) {
      try {
        console.log(LOG_PREFIX, 'Experience missing — trying enrichment fallback for:', personData.name);
        const enrichData = await deepLookupEnrich(personData.linkedinUrl, null, personData.name);
        if (enrichData) {
          this._mergeEnrichData(personData, enrichData);
        }
      } catch (err) {
        console.warn(LOG_PREFIX, 'Enrichment fallback failed:', (err as Error).message);
      }
    }

    personData.icp = deriveIcpProfile(personData);

    if (!personData.avatarUrl && email) {
      const gravatarUrl = await gravatarAvatarUrl(email);
      if (gravatarUrl) {
        personData.avatarUrl = gravatarUrl;
        console.log(LOG_PREFIX, 'Gravatar fallback set for:', personData.name);
      }
    }

    if (email && !personData.email) {
      personData.email = email;
    }

    // Write to both local Chrome cache and server cache (primary key + LinkedIn alias)
    const aliasKey = personData.linkedinUrl ? linkedInAliasKey(personData.linkedinUrl) : null;
    const cacheKeysToWrite = aliasKey && aliasKey !== cacheKey ? [cacheKey, aliasKey] : [cacheKey];

    for (const key of cacheKeysToWrite) {
      try {
        await this._cache.set(key, personData, CACHE_TTL_MS);
      } catch (err) {
        console.warn(LOG_PREFIX, `Local cache write failed for "${key}":`, (err as Error).message);
      }
    }

    for (const key of cacheKeysToWrite) {
      try {
        await this._serverCache.put({
          entityType: 'person',
          entityKey: key,
          enrichmentData: personData as unknown as Record<string, unknown>,
          confidence: personData._confidence ?? null,
          confidenceScore: personData._confidenceScore ?? null,
          source: personData._source ?? null,
        });
      } catch (err) {
        console.warn(LOG_PREFIX, `Server cache write failed for "${key}":`, (err as Error).message);
      }
    }

    if (aliasKey && aliasKey !== cacheKey) {
      console.log(LOG_PREFIX, `Wrote LinkedIn alias cache key: ${aliasKey}`);
    }

    console.log(
      LOG_PREFIX,
      `Waterfall complete for "${personData.name}" — source: ${personData._source}, confidence: ${personData._confidence}`,
    );

    return personData;
  }

  private _mergeCompanyIntel(personData: PersonData, companyIntel: CompanyInfo | Record<string, unknown>): void {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const ci = companyIntel as Record<string, unknown>;

    if (!personData.companyDescription) personData.companyDescription = str(ci.company_description);
    if (!personData.companyIndustry) personData.companyIndustry = str(ci.company_industry);
    if (!personData.companyWebsite) personData.companyWebsite = str(ci.company_website);
    if (!personData.companyFounded) personData.companyFounded = str(ci.company_founded_year);
    if (!personData.companyHeadquarters) personData.companyHeadquarters = str(ci.company_headquarters);
    if (!personData.companyFunding) personData.companyFunding = str(ci.company_funding);
    if (!personData.companyProducts) personData.companyProducts = str(ci.products_services);
    if (!personData.companyTechnologies) personData.companyTechnologies = str(ci.technologies);
    if (!personData.recentNews) personData.recentNews = str(ci.recent_news);

    console.log(
      LOG_PREFIX,
      'Merged company intel for:',
      personData.currentCompany,
      '— fields:',
      Object.keys(ci)
        .filter((k) => str(ci[k]))
        .join(', '),
    );
  }

  private _mergeEnrichData(personData: PersonData, enrichData: Record<string, unknown>): void {
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

    if (!personData.currentTitle && enrichData.current_position) {
      personData.currentTitle = str(enrichData.current_position);
    }

    if ((!personData.experience || personData.experience.length === 0) && enrichData.work_experience) {
      personData.experience = this._parseWorkExperienceText(String(enrichData.work_experience));
    }

    if ((!personData.education || personData.education.length === 0) && enrichData.education) {
      personData.education = this._parseEducationText(String(enrichData.education));
    }

    if (enrichData.skills && !personData.skills?.length) {
      personData.skills = String(enrichData.skills)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    console.log(
      LOG_PREFIX,
      'Merged enrich data — experience:',
      personData.experience?.length,
      'education:',
      personData.education?.length,
      'skills:',
      personData.skills?.length,
    );
  }

  private _parseWorkExperienceText(text: string): ExperienceEntry[] {
    if (!text) return [];
    const entries: ExperienceEntry[] = [];
    const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const atMatch = line.match(/^(.+?)\s+at\s+(.+?)(?:\s*[(\,]\s*(.+?)[)]?)?$/i);
      const dashMatch = line.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s*[(\,]\s*(.+?)[)]?)?$/i);

      if (atMatch) {
        entries.push({
          title: atMatch[1].trim(),
          company: atMatch[2].trim(),
          companyLogoUrl: null,
          startDate: atMatch[3]?.trim() || null,
          endDate: null,
          location: null,
          description: null,
        });
      } else if (dashMatch) {
        entries.push({
          title: dashMatch[2].trim(),
          company: dashMatch[1].trim(),
          companyLogoUrl: null,
          startDate: dashMatch[3]?.trim() || null,
          endDate: null,
          location: null,
          description: null,
        });
      } else if (line.length > 5) {
        entries.push({
          title: line,
          company: null,
          companyLogoUrl: null,
          startDate: null,
          endDate: null,
          location: null,
          description: null,
        });
      }
    }
    return entries;
  }

  private _parseEducationText(text: string): EducationEntry[] {
    if (!text) return [];
    const entries: EducationEntry[] = [];
    const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(.+?)(?:\s*[-–—,]\s*(.+?))?(?:\s*[(]\s*(.+?)[)])?$/);
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
