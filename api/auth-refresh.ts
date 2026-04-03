// PreMeet — Session Token Refresh
// POST /api/auth-refresh
//
// Accepts a refresh token, verifies it, and issues a new access token.
// The refresh token itself is not rotated (single-use rotation adds
// complexity without meaningful security for a Chrome extension).

export const config = { runtime: 'edge' };

import { corsHeaders, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { verifyToken, createAccessToken, hashToken } from './_shared/jwt';

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { refreshToken } = await req.json();

    if (!refreshToken || typeof refreshToken !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing refreshToken in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 1. Verify the refresh token JWT
    const payload = await verifyToken(refreshToken);

    if (payload.type !== 'refresh') {
      return new Response(
        JSON.stringify({ error: 'Invalid token type. Expected a refresh token.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 2. Verify session exists and token hash matches
    const tokenHash = await hashToken(refreshToken);

    const sessions = await sql`
      SELECT id, user_id, expires_at FROM sessions
      WHERE id = ${payload.sessionId} AND token_hash = ${tokenHash}
      LIMIT 1
    `;

    if (sessions.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Session not found or token mismatch' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const session = sessions[0];

    if (new Date(session.expires_at) < new Date()) {
      await sql`DELETE FROM sessions WHERE id = ${session.id}`;
      return new Response(
        JSON.stringify({ error: 'Session expired. Please sign in again.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Fetch current user data (tier may have changed)
    const users = await sql`
      SELECT id, email, subscription_tier FROM users WHERE id = ${session.user_id} LIMIT 1
    `;

    if (users.length === 0) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const user = users[0];

    // 4. Issue new access token
    const tier = user.subscription_tier as 'free' | 'pro';
    const accessToken = await createAccessToken({
      userId: user.id,
      email: user.email,
      tier,
      sessionId: session.id,
    });

    return new Response(
      JSON.stringify({ accessToken }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Refresh error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Token refresh failed' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
}
