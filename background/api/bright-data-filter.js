/**
 * background/api/bright-data-filter.js
 *
 * PreMeet – Filter API Client
 *
 * Queries the datasets Filter API to retrieve enriched person
 * data by LinkedIn ID:
 *   1. POST /datasets/filter  → creates a filter snapshot, returns snapshot_id
 *   2. GET  /datasets/snapshots/{id} → polls until status is "ready"
 *   3. GET  /datasets/snapshots/{id}/download?format=json → downloads results
 *
 * @module bright-data-filter
 */

'use strict';

const LOG_PREFIX = '[PreMeet][Filter]';

// ─── Constants ───────────────────────────────────────────────────────────────

const FILTER_ENDPOINT = 'https://api.brightdata.com/datasets/filter';
const SNAPSHOT_BASE   = 'https://api.brightdata.com/datasets/snapshots';

/** Default dataset: LinkedIn People Profiles. */
const DEFAULT_DATASET_ID = 'gd_l1viktl72bvl7bjuj0';

const POLL_INTERVAL_MS    = 2000;
const MAX_POLL_ATTEMPTS   = 50;   // ~100 s (snapshots can take 60-90s)
const FILTER_TIMEOUT_MS   = 120_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

function authHeadersGet(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Query the Filter API by LinkedIn ID and return enriched profile data.
 *
 * @param {string} linkedInId   LinkedIn profile ID/slug (e.g. "john-doe-123").
 * @param {string} apiToken     API bearer token.
 * @param {string} [datasetId]  Dataset ID (defaults to LinkedIn People Profiles).
 * @returns {Promise<Array<Object>>}  Array of enriched profile records.
 */
export async function filterByLinkedInId(linkedInId, apiToken, datasetId) {
  const dsId = datasetId || DEFAULT_DATASET_ID;

  console.log(LOG_PREFIX, `Filtering dataset ${dsId} by linkedin_id: "${linkedInId}"`);

  // ── Step 1: Create filter snapshot ──────────────────────────────────────
  const filterBody = {
    dataset_id: dsId,
    filter: {
      name:     'linkedin_id',
      operator: '=',
      value:    linkedInId,
    },
  };

  console.log(LOG_PREFIX, 'Filter request body:', JSON.stringify(filterBody));

  const createRes = await fetch(FILTER_ENDPOINT, {
    method:  'POST',
    headers: authHeaders(apiToken),
    body:    JSON.stringify(filterBody),
  });

  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => '');
    console.error(LOG_PREFIX, `Filter API HTTP ${createRes.status}:`, errBody.slice(0, 300));
    throw new Error(
      `Filter API returned HTTP ${createRes.status}: ${errBody.slice(0, 200)}`
    );
  }

  const createData = await createRes.json();
  const snapshotId = createData?.snapshot_id;

  if (!snapshotId) {
    throw new Error(
      'Filter API did not return snapshot_id: ' +
      JSON.stringify(createData).slice(0, 200)
    );
  }

  console.log(LOG_PREFIX, 'Filter snapshot created:', snapshotId);

  // ── Step 2: Poll snapshot until ready ───────────────────────────────────
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > FILTER_TIMEOUT_MS) {
      throw new Error(`Filter snapshot ${snapshotId} timed out after ${FILTER_TIMEOUT_MS / 1000}s`);
    }

    await sleep(POLL_INTERVAL_MS);

    console.log(
      LOG_PREFIX,
      `Polling snapshot ${snapshotId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`
    );

    const statusRes = await fetch(`${SNAPSHOT_BASE}/${snapshotId}`, {
      method:  'GET',
      headers: authHeadersGet(apiToken),
    });

    if (!statusRes.ok) {
      if (statusRes.status === 404) {
        // Snapshot may not yet be registered — retry.
        continue;
      }
      const errBody = await statusRes.text().catch(() => '');
      throw new Error(
        `Snapshot status check HTTP ${statusRes.status}: ${errBody.slice(0, 200)}`
      );
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

    // Status is scheduled/building — keep polling.
    console.log(LOG_PREFIX, `Snapshot status: ${status}`);

    if (attempt === MAX_POLL_ATTEMPTS) {
      throw new Error(
        `Filter snapshot ${snapshotId} not ready after ${MAX_POLL_ATTEMPTS} attempts`
      );
    }
  }

  // ── Step 3: Download snapshot data ──────────────────────────────────────
  // Brief delay — the download endpoint can lag behind the status endpoint.
  await sleep(1000);

  const downloadUrl = `${SNAPSHOT_BASE}/${snapshotId}/download?format=json`;

  console.log(LOG_PREFIX, 'Downloading snapshot:', snapshotId);

  const downloadRes = await fetch(downloadUrl, {
    method:  'GET',
    headers: authHeadersGet(apiToken),
  });

  if (!downloadRes.ok) {
    const errBody = await downloadRes.text().catch(() => '');
    throw new Error(
      `Snapshot download HTTP ${downloadRes.status}: ${errBody.slice(0, 200)}`
    );
  }

  // The download endpoint may return:
  //   - A JSON array: [{ ... }, { ... }]
  //   - NDJSON (newline-delimited JSON): { ... }\n{ ... }\n
  //   - A plain text error: "Snapshot is not ready" / "Snapshot is expired"
  const rawText = await downloadRes.text();

  // Guard against non-JSON text responses (e.g. "Snapshot is not ready").
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    throw new Error(
      `Snapshot download returned non-JSON response: "${trimmed.slice(0, 100)}"`
    );
  }

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (_jsonErr) {
    // Likely NDJSON — parse each line as a separate JSON object.
    const lines = trimmed.split('\n').filter(l => l.trim());
    data = [];
    for (const line of lines) {
      try {
        data.push(JSON.parse(line));
      } catch (_lineErr) {
        console.warn(LOG_PREFIX, 'Skipping unparseable NDJSON line:', line.slice(0, 100));
      }
    }
    if (data.length === 0) {
      throw new Error(
        'Snapshot download: could not parse response as JSON or NDJSON'
      );
    }
    console.log(LOG_PREFIX, `Parsed ${data.length} record(s) from NDJSON response`);
  }

  if (!Array.isArray(data)) {
    // Single object response — wrap in array.
    data = [data];
  }

  console.log(
    LOG_PREFIX,
    `Downloaded ${data.length} record(s) from filter snapshot ${snapshotId}`
  );

  return data;
}
