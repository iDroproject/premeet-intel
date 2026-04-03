// PreMeet — Stakeholder Map Enrichment (Pro power-up, 1 credit)
// POST /api/enrichment-stakeholder-map
//
// Stub endpoint — returns feature-not-available until backend is implemented.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { requireAuth } from './_shared/auth-middleware';

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  return new Response(
    JSON.stringify({
      error: 'Feature coming soon',
      message: 'Stakeholder map enrichment is not yet available.',
      data: null,
    }),
    { status: 501, headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}
