// PreMeet — BrightData Dataset Filter API Client
// Async: trigger filter → poll snapshot status → download results.
//
// Endpoint: POST https://api.brightdata.com/datasets/filter
// Status:   GET  https://api.brightdata.com/datasets/snapshot/{id}
// Download: GET  https://api.brightdata.com/datasets/snapshot/{id}/download?format=json
//
// Benchmarked latency: ~8-60s (trigger + poll + download)

const FILTER_URL = 'https://api.brightdata.com/datasets/filter';
const SNAPSHOT_URL = 'https://api.brightdata.com/datasets/snapshot';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 15; // ~45s max polling

export interface DatasetFilterResult {
  data: Record<string, unknown> | null;
  fields: number;
  snapshotId: string | null;
  latencyMs: number;
  error: string | null;
}

export interface FilterSpec {
  name: string;
  operator: '=' | 'includes' | 'not_in' | '!=' | '>' | '<' | '>=' | '<=';
  value: string;
}

/**
 * Query a BrightData pre-collected dataset by filter and return the first matching record.
 */
export async function queryDataset(
  datasetId: string,
  filters: FilterSpec[],
  apiKey: string,
  recordsLimit = 1,
  timeoutMs = 50_000,
): Promise<DatasetFilterResult> {
  const start = performance.now();

  try {
    // Step 1: Trigger filter
    const filterBody = filters.length === 1
      ? { dataset_id: datasetId, records_limit: recordsLimit, filter: filters[0] }
      : { dataset_id: datasetId, records_limit: recordsLimit, filter: { operator: 'and', filters } };

    const triggerResp = await fetch(FILTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(filterBody),
    });

    if (!triggerResp.ok) {
      const errText = await triggerResp.text().catch(() => '');
      return {
        data: null,
        fields: 0,
        snapshotId: null,
        latencyMs: elapsed(start),
        error: `Filter trigger HTTP ${triggerResp.status}: ${errText.slice(0, 200)}`,
      };
    }

    const triggerData = await triggerResp.json();
    const snapshotId = triggerData?.snapshot_id;

    if (!snapshotId) {
      return {
        data: null,
        fields: 0,
        snapshotId: null,
        latencyMs: elapsed(start),
        error: `No snapshot_id: ${JSON.stringify(triggerData).slice(0, 200)}`,
      };
    }

    // Step 2: Poll snapshot status
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      if (performance.now() - start > timeoutMs) {
        return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: `Timeout after ${Math.round(timeoutMs / 1000)}s` };
      }

      await sleep(POLL_INTERVAL_MS);

      const statusResp = await fetch(`${SNAPSHOT_URL}/${snapshotId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!statusResp.ok) continue;

      const statusData = await statusResp.json();
      const status = statusData.status;

      if (status === 'ready') {
        // Step 3: Download results
        return await downloadSnapshot(snapshotId, apiKey, start);
      }

      if (status === 'failed' || status === 'cancelled') {
        return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: `Snapshot ${status}` };
      }

      // 'scheduled' or 'building' — keep polling
    }

    return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: `Max poll attempts reached` };
  } catch (err) {
    return { data: null, fields: 0, snapshotId: null, latencyMs: elapsed(start), error: (err as Error).message };
  }
}

async function downloadSnapshot(
  snapshotId: string,
  apiKey: string,
  start: number,
  retries = 3,
): Promise<DatasetFilterResult> {
  for (let i = 0; i < retries; i++) {
    const dlResp = await fetch(`${SNAPSHOT_URL}/${snapshotId}/download?format=json`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!dlResp.ok) {
      return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: `Download HTTP ${dlResp.status}` };
    }

    const text = await dlResp.text();

    // "Snapshot is building" means data isn't ready yet despite status=ready
    if (text.includes('building') || text.includes('Try again')) {
      await sleep(3000);
      continue;
    }

    try {
      const parsed = JSON.parse(text);
      const record = Array.isArray(parsed) ? parsed[0] : parsed;

      if (!record || (typeof record === 'object' && Object.keys(record).length === 0)) {
        return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: 'Empty result set' };
      }

      return {
        data: record,
        fields: Object.keys(record).length,
        snapshotId,
        latencyMs: elapsed(start),
        error: null,
      };
    } catch {
      return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: `Parse error: ${text.slice(0, 100)}` };
    }
  }

  return { data: null, fields: 0, snapshotId, latencyMs: elapsed(start), error: 'Download retries exhausted (still building)' };
}

// ── Convenience helpers ──────────────────────────────────────────────────────

/** Query enriched company dataset by LinkedIn company slug (id_lc). */
export function queryCompany(companyLinkedinId: string, apiKey: string, timeoutMs = 50_000): Promise<DatasetFilterResult> {
  return queryDataset(
    'gd_m3fl0mwzmfpfn4cw4',
    [{ name: 'id_lc', operator: '=', value: companyLinkedinId }],
    apiKey,
    1,
    timeoutMs,
  );
}

/** Query enriched employee dataset by LinkedIn profile URL. */
export function queryEmployee(linkedinUrl: string, apiKey: string, timeoutMs = 50_000): Promise<DatasetFilterResult> {
  return queryDataset(
    'gd_m18zt6ec11wfqohyrs',
    [{ name: 'url', operator: '=', value: linkedinUrl }],
    apiKey,
    1,
    timeoutMs,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
