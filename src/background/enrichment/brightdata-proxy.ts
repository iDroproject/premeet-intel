// PreMeet — BrightData API Client
// Calls api.brightdata.com directly with the API key from build-time env.

const LOG_PREFIX = '[PreMeet][BDProxy]';
const BRIGHTDATA_BASE = 'https://api.brightdata.com';

function getApiKey(): string {
  const key = import.meta.env.VITE_BRIGHTDATA_API_KEY as string;
  if (!key) throw new Error('VITE_BRIGHTDATA_API_KEY not configured. Set it in .env');
  return key;
}

/**
 * Sends a request to BrightData directly.
 *
 * @param path   The BrightData API path (e.g. "/datasets/v3/scrape?dataset_id=...")
 * @param method "GET" or "POST"
 * @param body   Optional request body (for POST requests)
 * @returns      The Response object
 */
export async function proxyFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<Response> {
  const apiKey = getApiKey();
  const url = `${BRIGHTDATA_BASE}${path}`;

  console.log(LOG_PREFIX, `${method} ${path.split('?')[0]}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined && method === 'POST') {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  return response;
}
