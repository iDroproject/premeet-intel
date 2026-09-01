// PreMeet — BrightData Search Dataset API Client
//
// Synchronous, sub-second alternative to the async Dataset Filter flow:
//   POST https://api.brightdata.com/datasets/search/:dataset_id
//   body { filter, size, sort?, search_after? } → { hits, total_hits, took }
// There is no snapshot to poll and no download step — results are inline.
//
// The filter syntax is identical to the Dataset Filter API (see FilterSpec in
// dataset-filter.ts), so every existing filter maps 1:1. `records_limit` → `size`.
//
// Docs: https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset

import type { FilterSpec } from './dataset-filter';

const SEARCH_URL = 'https://api.brightdata.com/datasets/search';

/** Datasets the Search API supports (raw LinkedIn datasets, not the merged ones). */
export const SEARCH_DATASETS = {
  peopleProfiles: 'gd_l1viktl72bvl7bjuj0',
  peopleContactEnriched: 'gd_me5ppxjr2ge6icjuh0',
  companyInfo: 'gd_l1vikfnt1wgvvqz95w',
} as const;

export interface SearchDatasetResult {
  records: Array<Record<string, unknown>>;
  totalHits: number;
  tookMs: number;
  latencyMs: number;
  error: string | null;
}

/** Build the request `filter` from one-or-many FilterSpecs (same rule as the filter API). */
function buildFilter(filters: FilterSpec[]): FilterSpec | { operator: 'and'; filters: FilterSpec[] } {
  return filters.length === 1 ? filters[0] : { operator: 'and', filters };
}

/**
 * Run a synchronous Search Dataset query and return the matched records
 * (the `hits` envelope is unwrapped so callers get plain record objects, exactly
 * like the snapshot download produced).
 */
export async function searchDataset(
  datasetId: string,
  filters: FilterSpec[],
  apiKey: string,
  opts: { size?: number; timeoutMs?: number } = {},
): Promise<SearchDatasetResult> {
  const start = performance.now();
  const size = opts.size ?? 1;
  const timeoutMs = opts.timeoutMs ?? 12_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${SEARCH_URL}/${datasetId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: buildFilter(filters), size }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      // 422 = no matches (documented); treat as an empty result, not an error.
      if (resp.status === 422) {
        return { records: [], totalHits: 0, tookMs: 0, latencyMs: elapsed(start), error: null };
      }
      const errText = await resp.text().catch(() => '');
      return { records: [], totalHits: 0, tookMs: 0, latencyMs: elapsed(start), error: `Search HTTP ${resp.status}: ${errText.slice(0, 160)}` };
    }

    const body = await resp.json() as { hits?: unknown; total_hits?: number; took?: number };
    const records = Array.isArray(body.hits) ? (body.hits as Array<Record<string, unknown>>) : [];
    return {
      records,
      totalHits: typeof body.total_hits === 'number' ? body.total_hits : records.length,
      tookMs: typeof body.took === 'number' ? body.took : 0,
      latencyMs: elapsed(start),
      error: null,
    };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError' ? `Timeout after ${Math.round(timeoutMs / 1000)}s` : (err as Error).message;
    return { records: [], totalHits: 0, tookMs: 0, latencyMs: elapsed(start), error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
