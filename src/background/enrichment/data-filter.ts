// PreMeet – Filter API Client
// Queries Bright Data's Filter API to retrieve enriched person data by LinkedIn ID.
// All requests are proxied through the PreMeet backend.

import { proxyFetch } from './brightdata-proxy';

const LOG_PREFIX = '[PreMeet][Filter]';

const FILTER_PATH = '/datasets/filter';
const SNAPSHOT_BASE = '/datasets/snapshots';
const DEFAULT_DATASET_ID = 'gd_l1viktl72bvl7bjuj0';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 50;
const FILTER_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function filterByLinkedInId(
  linkedInId: string,
  datasetId?: string,
): Promise<Array<Record<string, unknown>>> {
  const dsId = datasetId || DEFAULT_DATASET_ID;

  console.log(LOG_PREFIX, `Filtering dataset ${dsId} by linkedin_id: "${linkedInId}"`);

  // Step 1: Create filter snapshot.
  const filterBody = {
    dataset_id: dsId,
    filter: { name: 'linkedin_id', operator: '=', value: linkedInId },
  };

  console.log(LOG_PREFIX, 'Filter request body:', JSON.stringify(filterBody));

  const createRes = await proxyFetch(FILTER_PATH, 'POST', filterBody);

  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => '');
    console.error(LOG_PREFIX, `Filter API HTTP ${createRes.status}:`, errBody.slice(0, 300));
    throw new Error(`Filter API returned HTTP ${createRes.status}: ${errBody.slice(0, 200)}`);
  }

  const createData = await createRes.json();
  const snapshotId = createData?.snapshot_id;

  if (!snapshotId) {
    throw new Error('Filter API did not return snapshot_id: ' + JSON.stringify(createData).slice(0, 200));
  }

  console.log(LOG_PREFIX, 'Filter snapshot created:', snapshotId);

  // Step 2: Poll snapshot until ready.
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > FILTER_TIMEOUT_MS) {
      throw new Error(`Filter snapshot ${snapshotId} timed out after ${FILTER_TIMEOUT_MS / 1000}s`);
    }

    await sleep(POLL_INTERVAL_MS);
    console.log(LOG_PREFIX, `Polling snapshot ${snapshotId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

    const statusRes = await proxyFetch(`${SNAPSHOT_BASE}/${snapshotId}`, 'GET');

    if (!statusRes.ok) {
      if (statusRes.status === 404) continue; // Snapshot may not yet be registered.
      const errBody = await statusRes.text().catch(() => '');
      throw new Error(`Snapshot status check HTTP ${statusRes.status}: ${errBody.slice(0, 200)}`);
    }

    const statusData = await statusRes.json();
    const status = statusData?.status;

    if (status === 'ready') {
      console.log(LOG_PREFIX, `Snapshot ${snapshotId} is ready`);
      break;
    }

    if (status === 'failed') {
      const errMsg = statusData?.error || 'unknown';
      throw new Error(`Filter snapshot ${snapshotId} failed: ${errMsg}`);
    }

    console.log(LOG_PREFIX, `Snapshot status: ${status}`);

    if (attempt === MAX_POLL_ATTEMPTS) {
      throw new Error(`Filter snapshot ${snapshotId} not ready after ${MAX_POLL_ATTEMPTS} attempts`);
    }
  }

  // Step 3: Download snapshot data.
  await sleep(1000); // Brief delay — download endpoint can lag behind status.

  const downloadPath = `${SNAPSHOT_BASE}/${snapshotId}/download?format=json`;
  console.log(LOG_PREFIX, 'Downloading snapshot:', snapshotId);

  const downloadRes = await proxyFetch(downloadPath, 'GET');

  if (!downloadRes.ok) {
    const errBody = await downloadRes.text().catch(() => '');
    throw new Error(`Snapshot download HTTP ${downloadRes.status}: ${errBody.slice(0, 200)}`);
  }

  const rawText = await downloadRes.text();
  const trimmed = rawText.trim();

  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    throw new Error(`Snapshot download returned non-JSON response: "${trimmed.slice(0, 100)}"`);
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // NDJSON
    const lines = trimmed.split('\n').filter((l) => l.trim());
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        console.warn(LOG_PREFIX, 'Skipping unparseable NDJSON line:', line.slice(0, 100));
      }
    }
    if (parsed.length === 0) throw new Error('Snapshot download: could not parse response as JSON or NDJSON');
    console.log(LOG_PREFIX, `Parsed ${parsed.length} record(s) from NDJSON response`);
    return parsed;
  }

  if (!Array.isArray(data)) {
    data = [data];
  }

  console.log(LOG_PREFIX, `Downloaded ${(data as Array<unknown>).length} record(s) from filter snapshot ${snapshotId}`);
  return data as Array<Record<string, unknown>>;
}
