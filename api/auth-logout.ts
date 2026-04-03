// PreMeet — Logout / Session Invalidation
// POST /api/auth-logout
//
// Invalidates the current session by deleting it from the sessions table.
// Accepts either the access token (via Authorization header) or
// the refresh token in the body.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
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

  const { sessionId, userId } = auth.context;

  // Delete the session
  try {
    await sql`DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`;
  } catch (err) {
    console.error('Logout error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Failed to invalidate session' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}
