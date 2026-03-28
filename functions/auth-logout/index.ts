// PreMeet — Logout / Session Invalidation
// POST /functions/v1/auth-logout
//
// Invalidates the current session by deleting it from the sessions table.
// Accepts either the access token (via Authorization header) or
// the refresh token in the body.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { sql } from '../_shared/db.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
