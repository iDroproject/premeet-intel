// PreMeet — Fetch with retry for edge functions
// Wraps fetch with exponential backoff for transient BrightData/SERP failures.

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

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
 * Fetch with automatic retry for transient failures (5xx, 429, network errors).
 * Returns the Response on success or final attempt; throws on exhausted network errors.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label = 'fetch',
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || response.status === 202 || !isTransientStatus(response.status)) {
        return response;
      }

      // Transient HTTP error — retry if attempts remain
      if (attempt < RETRY_MAX_ATTEMPTS) {
        const retryAfterMs = parseRetryAfter(response);
        const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        const delayMs = retryAfterMs ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS) : backoffMs;
        console.warn(`[${label}] HTTP ${response.status} — retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        await sleep(delayMs);
        continue;
      }

      console.warn(`[${label}] failed after ${RETRY_MAX_ATTEMPTS} attempts (HTTP ${response.status})`);
      return response;
    } catch (err) {
      lastError = err as Error;

      if (attempt < RETRY_MAX_ATTEMPTS) {
        const backoffMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
        console.warn(`[${label}] network error: ${lastError.message} — retrying in ${backoffMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`);
        await sleep(backoffMs);
        continue;
      }

      console.error(`[${label}] failed after ${RETRY_MAX_ATTEMPTS} attempts: ${lastError.message}`);
      throw lastError;
    }
  }

  throw lastError || new Error(`${label} failed after ${RETRY_MAX_ATTEMPTS} attempts`);
}
