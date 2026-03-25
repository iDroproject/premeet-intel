// PreMeet — BrightData Proxy Client
// Routes all BrightData API calls through the PreMeet backend
// (Supabase Edge Function: enrichment-proxy) so the extension
// never contacts api.brightdata.com directly.

import { authFetch } from '../../lib/auth';

const LOG_PREFIX = '[PreMeet][BDProxy]';

function getProxyUrl(): string {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  if (!url) throw new Error('VITE_SUPABASE_URL not configured');
  return `${url}/functions/v1/enrichment-proxy`;
}

/**
 * Sends a request to BrightData via the PreMeet backend proxy.
 *
 * @param path   The BrightData API path (e.g. "/datasets/v3/scrape?dataset_id=...")
 * @param method "GET" or "POST"
 * @param body   Optional request body (for POST requests)
 * @returns      The proxied Response object
 */
export async function proxyFetch(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<Response> {
  const proxyUrl = getProxyUrl();

  console.log(LOG_PREFIX, `${method} ${path.split('?')[0]}`);

  const payload: Record<string, unknown> = { path, method };
  if (body !== undefined) {
    payload.body = body;
  }

  const response = await authFetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return response;
}
