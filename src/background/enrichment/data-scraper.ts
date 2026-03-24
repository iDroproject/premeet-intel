// PreMeet – Web Scraper API Client (WSA)
// Scrapes LinkedIn profiles via Bright Data's datasets API.

const LOG_PREFIX = '[PreMeet][Scraper]';

const BASE_URL = 'https://api.brightdata.com';
const DATASET_ID = 'gd_l1viktl72bvl7bjuj0';
const SCRAPE_ENDPOINT = `${BASE_URL}/datasets/v3/scrape?dataset_id=${DATASET_ID}&notify=false&include_errors=true`;
const SNAPSHOT_BASE = `${BASE_URL}/datasets/snapshots`;

const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2000;

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
}

async function fetchWithErrorHandling(url: string, options: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    throw new Error(`Network error: ${(networkErr as Error).message}`);
  }

  if (!response.ok && response.status !== 202) {
    let bodyExcerpt = '';
    try {
      const text = await response.text();
      bodyExcerpt = text.slice(0, 200);
    } catch {
      // ignore
    }
    throw new Error(`API returned HTTP ${response.status}${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`);
  }

  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function extractLinkedInIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  return match ? decodeURIComponent(match[1]).replace(/\/+$/, '') : null;
}

export function extractLinkedInId(profile: Record<string, unknown>, fallbackUrl?: string): string | null {
  if (profile?.linkedin_id) return String(profile.linkedin_id);
  if (profile?.id) return String(profile.id);
  if (profile?.url) return extractLinkedInIdFromUrl(String(profile.url));
  if (fallbackUrl) return extractLinkedInIdFromUrl(fallbackUrl);
  return null;
}

export interface ScrapeResult {
  mode: 'direct' | 'snapshot';
  profiles?: Array<Record<string, unknown>>;
  snapshotId?: string;
}

export async function scrapeByLinkedInUrl(linkedInUrl: string, apiToken: string): Promise<ScrapeResult> {
  console.log(LOG_PREFIX, 'Scraping LinkedIn URL:', linkedInUrl);

  const response = await fetchWithErrorHandling(SCRAPE_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(apiToken),
    body: JSON.stringify({ input: [{ url: linkedInUrl }] }),
  });

  if (response.status === 202) {
    const body = await response.json();
    const snapshotId = body?.snapshot_id;
    if (!snapshotId) throw new Error('Received HTTP 202 but no snapshot_id in body');
    console.log(LOG_PREFIX, 'Scrape queued, snapshot_id:', snapshotId);
    return { mode: 'snapshot', snapshotId };
  }

  const raw = await response.json();
  const profiles: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const valid = profiles.filter((p) => !p.error && !p.error_code);

  console.log(LOG_PREFIX, `Scrape returned ${profiles.length} profile(s) directly, ${valid.length} valid`);
  return { mode: 'direct', profiles: valid };
}

export async function pollSnapshotUntilReady(snapshotId: string, apiToken: string): Promise<void> {
  const statusUrl = `${SNAPSHOT_BASE}/${snapshotId}`;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `Polling snapshot ${snapshotId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

    const response = await fetchWithErrorHandling(statusUrl, {
      method: 'GET',
      headers: authHeaders(apiToken),
    });

    const status = await response.json();

    if (status.status === 'ready') {
      console.log(LOG_PREFIX, `Snapshot ${snapshotId} is ready`);
      return;
    }

    if (status.status === 'failed') {
      throw new Error(`Snapshot ${snapshotId} failed`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Snapshot ${snapshotId} did not become ready after ${MAX_POLL_ATTEMPTS} attempts`);
}

export async function downloadSnapshot(snapshotId: string, apiToken: string): Promise<Array<Record<string, unknown>>> {
  const downloadUrl = `${SNAPSHOT_BASE}/${snapshotId}/download?format=json`;
  console.log(LOG_PREFIX, 'Downloading snapshot:', snapshotId);

  const response = await fetchWithErrorHandling(downloadUrl, {
    method: 'GET',
    headers: authHeaders(apiToken),
  });

  const rawText = await response.text();
  const trimmed = rawText.trim();

  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    throw new Error(`Snapshot download returned non-JSON: "${trimmed.slice(0, 100)}"`);
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // NDJSON: one JSON object per line.
    const lines = trimmed.split('\n').filter((l) => l.trim());
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // skip unparseable lines
      }
    }
    if (parsed.length === 0) throw new Error('Could not parse snapshot response as JSON or NDJSON');
    console.log(LOG_PREFIX, `Parsed ${parsed.length} record(s) from NDJSON`);
    return parsed;
  }

  if (!Array.isArray(data)) {
    data = [data];
  }

  console.log(LOG_PREFIX, `Downloaded ${(data as Array<unknown>).length} record(s) from snapshot ${snapshotId}`);
  return data as Array<Record<string, unknown>>;
}
