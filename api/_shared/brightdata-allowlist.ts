// PreMeet — BrightData proxy allowlist & request classification.
//
// The enrichment proxy must never forward an arbitrary path/URL to BrightData
// with the owner's API key. This module defines exactly which BrightData routes
// the extension's waterfall legitimately uses, classifies which ones start a
// *billable* job (so they can be rate-limited/logged), and validates the request
// body to prevent turning the account into an open web-scraping proxy (SSRF).

/** Known BrightData dataset IDs the extension is allowed to query. */
export const ALLOWED_DATASET_IDS = new Set([
  'gd_l1viktl72bvl7bjuj0', // LinkedIn people profiles (scrape + filter + search)
  'gd_me5ppxjr2ge6icjuh0', // LinkedIn people, contact-enriched (search)
  'gd_l1vikfnt1wgvvqz95w', // LinkedIn company info (search)
  'gd_m3fl0mwzmfpfn4cw4',  // Enriched company (331 datapoints, filter)
  'gd_mcswdt6z2elth3zqr2', // Google AI Mode (company deep)
]);

/** SERP zone the unblocker is allowed to use. */
const ALLOWED_SERP_ZONE = 'serp';

export interface ProxyDecision {
  ok: boolean;
  /** True when this call starts a billable BrightData job (rate-limit + log it). */
  billable: boolean;
  /** Short label for audit logging. */
  label: string;
  /** Error message when ok === false. */
  error?: string;
}

/**
 * Allowlist rules keyed by HTTP method. Each entry matches the pathname (query
 * stripped) and marks whether the route is billable (starts a job) vs a free
 * status/download poll.
 */
const RULES: Array<{
  method: 'GET' | 'POST';
  test: RegExp;
  billable: boolean;
  label: string;
}> = [
  // Async Dataset Filter: trigger (billable) → snapshot status/download (free polls)
  { method: 'POST', test: /^\/datasets\/filter$/, billable: true, label: 'filter-trigger' },
  // Synchronous Search Dataset API: inline results (billable)
  { method: 'POST', test: /^\/datasets\/search\/[a-z0-9_]+$/i, billable: true, label: 'search' },
  // Snapshot status / download — both singular and plural forms BrightData has used
  { method: 'GET', test: /^\/datasets\/snapshots?\/[a-zA-Z0-9_-]+$/, billable: false, label: 'snapshot-status' },
  { method: 'GET', test: /^\/datasets\/snapshots?\/[a-zA-Z0-9_-]+\/download$/, billable: false, label: 'snapshot-download' },
  { method: 'GET', test: /^\/datasets\/v3\/progress\/[a-zA-Z0-9_-]+$/, billable: false, label: 'progress' },
  // WSA scrape trigger (billable); dataset_id validated separately below
  { method: 'POST', test: /^\/datasets\/v3\/scrape$/, billable: true, label: 'scrape-trigger' },
  // Deep Lookup: trigger (billable) → request status/result (free)
  { method: 'POST', test: /^\/datasets\/deep_lookup\/v1\/trigger_enrichment$/, billable: true, label: 'deep-lookup-trigger' },
  { method: 'GET', test: /^\/datasets\/deep_lookup\/v1\/request\/[a-zA-Z0-9_-]+(\/status)?$/, billable: false, label: 'deep-lookup-status' },
  // SERP via unblocker: send (billable) → poll result (free)
  { method: 'POST', test: /^\/unblocker\/req$/, billable: true, label: 'serp-send' },
  { method: 'GET', test: /^\/unblocker\/get_result$/, billable: false, label: 'serp-result' },
];

function parsePath(rawPath: string): { pathname: string; params: URLSearchParams } | null {
  try {
    // Resolve against a dummy base so relative paths parse; keeps query intact.
    const u = new URL(rawPath, 'https://api.brightdata.com');
    return { pathname: u.pathname, params: u.searchParams };
  } catch {
    return null;
  }
}

/**
 * Decide whether a proxied BrightData request is allowed. Validates path against
 * the allowlist, pins dataset_id query params to known datasets, and blocks the
 * unblocker from fetching any URL other than a Google search (SSRF guard).
 */
export function classifyProxyRequest(
  method: string,
  rawPath: string,
  body: unknown,
): ProxyDecision {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'POST') {
    return { ok: false, billable: false, label: 'method', error: 'Only GET and POST are supported' };
  }

  const parsed = parsePath(rawPath);
  if (!parsed) {
    return { ok: false, billable: false, label: 'parse', error: 'Malformed path' };
  }
  const { pathname, params } = parsed;

  const rule = RULES.find((r) => r.method === m && r.test.test(pathname));
  if (!rule) {
    return { ok: false, billable: false, label: 'denied', error: `Path not allowed: ${m} ${pathname}` };
  }

  // Pin dataset_id on scrape/filter/search to known datasets.
  const datasetInQuery = params.get('dataset_id');
  if (datasetInQuery && !ALLOWED_DATASET_IDS.has(datasetInQuery)) {
    return { ok: false, billable: false, label: 'dataset', error: 'Unknown dataset_id' };
  }
  // Search path carries the dataset id in the path segment.
  if (rule.label === 'search') {
    const ds = pathname.split('/').pop() || '';
    if (!ALLOWED_DATASET_IDS.has(ds)) {
      return { ok: false, billable: false, label: 'dataset', error: 'Unknown search dataset_id' };
    }
  }
  // Filter trigger carries dataset_id in the JSON body.
  if (rule.label === 'filter-trigger') {
    const ds = (body as { dataset_id?: string } | null)?.dataset_id;
    if (ds && !ALLOWED_DATASET_IDS.has(ds)) {
      return { ok: false, billable: false, label: 'dataset', error: 'Unknown filter dataset_id' };
    }
  }

  // SSRF guard: the unblocker must only fetch Google search URLs, and only on
  // the serp zone. Otherwise the account becomes an open web proxy.
  if (rule.label === 'serp-send') {
    if (params.get('zone') !== ALLOWED_SERP_ZONE && params.has('zone')) {
      return { ok: false, billable: false, label: 'zone', error: 'Unsupported zone' };
    }
    const url = (body as { url?: string } | null)?.url ?? '';
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { ok: false, billable: false, label: 'ssrf', error: 'SERP url must be an absolute URL' };
    }
    const host = target.hostname.toLowerCase();
    const isGoogleSearch =
      (host === 'www.google.com' || host === 'google.com') && target.pathname.startsWith('/search');
    if (target.protocol !== 'https:' || !isGoogleSearch) {
      return { ok: false, billable: false, label: 'ssrf', error: 'SERP url must be an https Google search URL' };
    }
  }
  if (rule.label === 'serp-result' && params.has('zone') && params.get('zone') !== ALLOWED_SERP_ZONE) {
    return { ok: false, billable: false, label: 'zone', error: 'Unsupported zone' };
  }

  return { ok: true, billable: rule.billable, label: rule.label };
}
