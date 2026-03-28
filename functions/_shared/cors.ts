// Shared CORS headers for PreMeet Edge Functions.
// Chrome extensions send requests from chrome-extension:// origins.

const ALLOWED_ORIGIN_PATTERNS = [
  /^chrome-extension:\/\/[a-z]{32}$/,
];

/**
 * Returns CORS headers for a given request origin.
 * Only allows chrome-extension:// origins; falls back to denying unknown origins
 * by omitting Access-Control-Allow-Origin (browser will block the request).
 */
export function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isAllowed =
    requestOrigin !== null &&
    ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(requestOrigin));

  return {
    'Access-Control-Allow-Origin': isAllowed ? requestOrigin! : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

/**
 * Convenience export for handlers that already have the Request object.
 */
export function corsHeadersFor(req: Request): Record<string, string> {
  return getCorsHeaders(req.headers.get('origin'));
}

/** @deprecated Use getCorsHeaders(req.headers.get('origin')) instead. */
export const corsHeaders = getCorsHeaders(null);

export function corsResponse(req?: Request): Response {
  const headers = req ? corsHeadersFor(req) : corsHeaders;
  return new Response(null, { status: 204, headers });
}
