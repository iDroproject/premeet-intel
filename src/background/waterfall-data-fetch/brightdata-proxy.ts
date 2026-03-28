// PreMeet — BrightData API Proxy Client
// Routes all BrightData requests through the server-side enrichment-proxy
// edge function, which holds the API key. The extension never contacts
// api.brightdata.com directly.

import { authFetch } from '../../lib/auth';

const LOG_PREFIX = '[PreMeet][BDProxy]';

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

function getProxyUrl(): string {
  const base = import.meta.env.VITE_API_BASE_URL as string;
  if (!base) throw new Error('VITE_API_BASE_URL not configured. Set it in .env');
  return `${base}/enrichment-proxy`;
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
 * Sends a request to BrightData via the server-side enrichment-proxy,
 * with automatic retry on transient errors.
 *
 * The proxy expects: { path, method, body }
 * It adds the BrightData API key server-side and forwards the request.
 *
 * @param path      The BrightData API path (e.g. "/datasets/v3/scrape?dataset_id=...")
 * @param method    "GET" or "POST"
 * @param body      Optional request body (for POST requests)
 * @returns         The Response object from the proxy
 */
export async function proxyFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<Response> {
  const proxyUrl = getProxyUrl();
  const pathLabel = path.split('?')[0];

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    console.log(LOG_PREFIX, `${method} ${pathLabel}${attempt > 1 ? ` (retry ${attempt - 1}/${RETRY_MAX_ATTEMPTS - 1})` : ''}`);

    try {
      const response = await authFetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, method, body }),
      });

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
      lastError = err as Error;

      if (attempt < RETRY_MAX_ATTEMPTS) {
        const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        console.warn(
          LOG_PREFIX,
          `${method} ${pathLabel} error: ${lastError.message} — retrying in ${backoffMs}ms`,
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
