// PreMeet — BrightData API Client
// Calls BrightData APIs directly with Bearer token authentication.
// The API key is loaded from VITE_BRIGHTDATA_API_KEY at build time.
//
// TODO(security): The BrightData API key is currently bundled into the
// extension at build time via VITE_BRIGHTDATA_API_KEY. This key should be
// moved to a server-side proxy (e.g. a Supabase Edge Function) so that it
// is never shipped in the extension package and cannot be extracted by users.
// All BrightData requests should go through that proxy, authenticated with
// the user's PreMeet session token.

const LOG_PREFIX = '[PreMeet][BDProxy]';

const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function getApiKey(): string {
  const key = import.meta.env.VITE_BRIGHTDATA_API_KEY as string;
  if (!key) throw new Error('VITE_BRIGHTDATA_API_KEY not configured. Set it in .env');
  return key;
}

/** Returns true for errors worth retrying (5xx, 429, network failures). */
function isTransientError(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parses Retry-After header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a request to BrightData directly with Bearer token auth, with automatic retry.
 *
 * @param path      The BrightData API path (e.g. "/datasets/v3/scrape?dataset_id=...")
 * @param method    "GET" or "POST"
 * @param body      Optional request body (for POST requests)
 * @param timeoutMs Optional per-request timeout in ms (default 30s)
 * @returns         The Response object
 */
export async function proxyFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${BRIGHTDATA_BASE_URL}${path}`;
  const pathLabel = path.split('?')[0];

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `${method} ${pathLabel}${attempt > 1 ? ` (retry ${attempt - 1}/${RETRY_MAX_ATTEMPTS - 1})` : ''}`);

    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
      };
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined && method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      clearTimeout(timerId);

      console.log(LOG_PREFIX, `${method} ${pathLabel} → HTTP ${response.status} (attempt ${attempt})`);

      // Don't retry on success or non-transient errors (4xx except 429)
      if (response.ok || !isTransientError(response.status)) {
        return response;
      }

      // Transient error — retry if attempts remain
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const retryAfterMs = parseRetryAfter(response);
        const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        const delayMs = retryAfterMs ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS) : backoffMs;

        console.warn(
          LOG_PREFIX,
          `${method} ${pathLabel} returned HTTP ${response.status} — retrying in ${Math.round(delayMs)}ms`,
        );
        await sleep(delayMs);
        continue;
      }

      // Final attempt exhausted — return the error response as-is
      console.warn(LOG_PREFIX, `${method} ${pathLabel} failed after ${RETRY_MAX_ATTEMPTS} attempts (HTTP ${response.status})`);
      return response;
    } catch (err) {
      clearTimeout(timerId);

      // AbortController timeout
      if ((err as Error).name === 'AbortError') {
        lastError = new Error(`${method} ${pathLabel} timed out after ${timeoutMs / 1000}s`);
        if (attempt < RETRY_MAX_ATTEMPTS) {
          console.warn(LOG_PREFIX, `${lastError.message} — retrying`);
          continue;
        }
        console.error(LOG_PREFIX, `${lastError.message} (final attempt)`);
        throw lastError;
      }

      // Network error (DNS, connection refused, etc.)
      lastError = err as Error;

      if (attempt < RETRY_MAX_ATTEMPTS) {
        const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        console.warn(
          LOG_PREFIX,
          `${method} ${pathLabel} network error: ${lastError.message} — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
        continue;
      }

      console.error(LOG_PREFIX, `${method} ${pathLabel} failed after ${RETRY_MAX_ATTEMPTS} attempts: ${lastError.message}`);
      throw lastError;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error(`${method} ${pathLabel} failed after ${RETRY_MAX_ATTEMPTS} attempts`);
}
