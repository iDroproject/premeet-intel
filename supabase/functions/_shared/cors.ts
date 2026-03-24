// Shared CORS headers for PreMeet Edge Functions.
// Chrome extensions send requests from chrome-extension:// origins.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function corsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
