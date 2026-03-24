// PreMeet – Waterfall Fetch Orchestrator
// Executes a deterministic multi-layer lookup cascade for a given person.

import { scrapeByLinkedInUrl, pollSnapshotUntilReady, downloadSnapshot, extractLinkedInId } from './data-scraper';
import { deepLookupFindLinkedIn, deepLookupEnrich, deepLookupCompanyIntel } from './deep-lookup';
import { serpFindLinkedInUrl, serpSearchCompanyInfo } from './serp-api';
import { filterByLinkedInId } from './data-filter';
import { pickBestProfile, mergeBusinessEnrichedData, deriveIcpProfile } from './response-normalizer';
import type { CacheManager } from './cache-manager';
import type { PersonData, ProgressPayload, StepState, WaterfallPayload, CompanyInfo, ExperienceEntry, EducationEntry } from './types';

const LOG_PREFIX = '[PreMeet][Waterfall]';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PIPELINE_STEPS: Array<Omit<StepState, 'status'>> = [
  { id: 'cache', label: 'Checking cache...', icon: 'cache', percent: 5 },
  { id: 'serp-discovery', label: 'Searching Google for LinkedIn...', icon: 'search', percent: 20 },
  { id: 'deep-lookup', label: 'Deep lookup by email...', icon: 'magnifier', percent: 40 },
  { id: 'linkedin-scraper', label: 'Scraping LinkedIn profile...', icon: 'linkedin', percent: 60 },
  { id: 'filter-enrich', label: 'Fetching enriched data...', icon: 'filter', percent: 90 },
];

const LAYER_TIMEOUTS = {
  serpDiscovery: 35_000,
  deepLookup: 90_000,
  linkedInScraper: 60_000,
  filterEnrich: 130_000,
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

function normaliseCacheKey(value: string): string {
  return (value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
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
  private _apiToken: string;
  private _logBuffer: LogBuffer | null;
  private _personName: string = '';
  private _stepsState: StepState[];

  onProgress: ((payload: ProgressPayload) => void) | null = null;
  onInterimResult: ((data: PersonData) => void) | null = null;

  constructor(cacheManager: CacheManager, apiToken: string, logBuffer?: LogBuffer | null) {
    this._cache = cacheManager;
    this._apiToken = apiToken;
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

  // ── Layer implementations ──────────────────────────────────────────────────

  private async _layerCache(cacheKey: string): Promise<CacheLayerResult> {
    const cached = await this._cache.get<PersonData>(cacheKey);
    if (cached) return { success: true, _cachedData: cached };
    return { success: false };
  }

  private async _layerSerpDiscovery(email: string, name: string, company: string): Promise<DiscoveryLayerResult> {
    let linkedInUrl: string | null = null;

    if (email && email.includes('@')) {
      console.log(LOG_PREFIX, 'SERP: searching by email:', email);
      linkedInUrl = await serpFindLinkedInUrl(email, this._apiToken);
    }

    if (!linkedInUrl && name) {
      const query = company ? `${name} ${company}` : name;
      console.log(LOG_PREFIX, 'SERP: searching by name:', query);
      linkedInUrl = await serpFindLinkedInUrl(query, this._apiToken);
    }

    if (!linkedInUrl) return { success: false, error: 'SERP found no LinkedIn URL' };
    return { success: true, linkedInUrl, source: 'serp' };
  }

  private async _layerDeepLookup(email: string, name: string, company: string): Promise<DiscoveryLayerResult> {
    const result = await deepLookupFindLinkedIn(email, name, company, this._apiToken);
    if (!result.linkedInUrl) return { success: false, error: 'Deep Lookup found no LinkedIn URL' };
    return { success: true, linkedInUrl: result.linkedInUrl, source: 'deep-lookup' };
  }

  private async _layerLinkedInScraper(linkedInUrl: string): Promise<ScraperLayerResult> {
    const scrapeResult = await scrapeByLinkedInUrl(linkedInUrl, this._apiToken);

    let profiles: Array<Record<string, unknown>> = [];

    if (scrapeResult.mode === 'direct') {
      profiles = scrapeResult.profiles || [];
    } else if (scrapeResult.mode === 'snapshot' && scrapeResult.snapshotId) {
      await pollSnapshotUntilReady(scrapeResult.snapshotId, this._apiToken);
      profiles = await downloadSnapshot(scrapeResult.snapshotId, this._apiToken);
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
    const profiles = await filterByLinkedInId(linkedInId, this._apiToken);
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

    // Layer 4: LinkedIn Scraper
    let linkedInId: string | null = null;
    let scraperProfiles: Array<Record<string, unknown>> | null = null;

    {
      const scraperResult = await this._runLayer(
        'linkedin-scraper',
        'linkedin-scraper',
        () => this._layerLinkedInScraper(linkedInUrl),
        LAYER_TIMEOUTS.linkedInScraper,
      );

      const sr = scraperResult as ScraperLayerResult & { elapsedMs: number };

      if (sr.success && sr.linkedInId) {
        linkedInId = sr.linkedInId;
        scraperProfiles = sr.profiles || null;

        if (sr.profiles?.length) {
          const interimData = pickBestProfile(sr.profiles, name, 'scraper', { email, serpVerified });
          if (interimData && typeof this.onInterimResult === 'function') {
            try {
              this.onInterimResult(interimData);
            } catch {
              // swallow
            }
          }
        }
      } else {
        this._notifyProgress('filter-enrich', 'skipped');

        if (sr.success && sr.profiles?.length) {
          const data = await this._finalise(
            { profiles: sr.profiles, source: 'scraper' as const },
            name,
            email,
            cacheKey,
            identifier,
            { serpVerified },
          );
          if (data) return data;
        }

        throw new Error(`Could not determine LinkedIn ID for "${identifier}"`);
      }
    }

    // Layer 5: Filter API + Company Intel (parallel)
    const interimCompany =
      (scraperProfiles?.[0]?.current_company as Record<string, unknown>)?.name ??
      scraperProfiles?.[0]?.current_company_name ??
      company;
    const interimTitle =
      (scraperProfiles?.[0]?.current_company as Record<string, unknown>)?.title ?? scraperProfiles?.[0]?.position ?? null;

    const [filterResult, companyIntel, serpCompanyInfo] = await Promise.all([
      this._runLayer('filter-enrich', 'filter-enrich', () => this._layerFilterEnrich(linkedInId), LAYER_TIMEOUTS.filterEnrich),
      deepLookupCompanyIntel(
        String(interimCompany || ''),
        name,
        interimTitle ? String(interimTitle) : null,
        linkedInUrl,
        this._apiToken,
      ).catch((err) => {
        console.warn(LOG_PREFIX, 'Company intel failed (non-fatal):', (err as Error).message);
        this._logBuffer?.warn('Waterfall', 'Company intel failed: ' + (err as Error).message);
        return null;
      }),
      serpSearchCompanyInfo(String(interimCompany || ''), this._apiToken).catch((err) => {
        console.warn(LOG_PREFIX, 'SERP company search failed (non-fatal):', (err as Error).message);
        return null;
      }),
    ]);

    const fr = filterResult as FilterLayerResult & { elapsedMs: number };

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

    throw new Error(`All enrichment layers failed for "${identifier}" (LinkedIn URL: ${linkedInUrl})`);
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
        const enrichData = await deepLookupEnrich(personData.linkedinUrl, null, personData.name, this._apiToken);
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

    try {
      await this._cache.set(cacheKey, personData, CACHE_TTL_MS);
    } catch (err) {
      console.warn(LOG_PREFIX, `Cache write failed for "${identifier}":`, (err as Error).message);
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
