// PreMeet — Session Token Refresh
// POST /functions/v1/auth-refresh
//
// Accepts a refresh token, verifies it, and issues a new access token.
// The refresh token itself is not rotated (single-use rotation adds
// complexity without meaningful security for a Chrome extension).

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { adminClient } from '../_shared/db.ts';
import { verifyToken, createAccessToken, hashToken } from '../_shared/jwt.ts';

serve(async (req: Request) => {
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

    const { data: session, error: sessionError } = await adminClient
      .from('sessions')
      .select('id, user_id, expires_at')
      .eq('id', payload.sessionId)
      .eq('token_hash', tokenHash)
      .single();

    if (sessionError || !session) {
      return new Response(
        JSON.stringify({ error: 'Session not found or token mismatch' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (new Date(session.expires_at) < new Date()) {
      await adminClient.from('sessions').delete().eq('id', session.id);
      return new Response(
        JSON.stringify({ error: 'Session expired. Please sign in again.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 3. Fetch current user data (tier may have changed)
    const { data: user, error: userError } = await adminClient
      .from('users')
      .select('id, email, subscription_tier')
      .eq('id', session.user_id)
      .single();

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'User not found' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

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
});
