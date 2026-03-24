// PreMeet — Google OAuth Token Exchange
// POST /functions/v1/auth-google
//
// The Chrome extension obtains a Google access token via chrome.identity,
// then sends it here. We verify the token with Google, create or find
// the user, create a session, and return access + refresh tokens.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { adminClient } from '../_shared/db.ts';
import { createAccessToken, createRefreshToken, hashToken } from '../_shared/jwt.ts';

interface GoogleUserInfo {
  sub: string; // Google user ID
  email: string;
  name: string;
  picture?: string;
}

async function verifyGoogleToken(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token verification failed (${res.status}): ${body}`);
  }

  return res.json();
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { googleAccessToken } = await req.json();

    if (!googleAccessToken || typeof googleAccessToken !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing googleAccessToken in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 1. Verify the Google access token
    const googleUser = await verifyGoogleToken(googleAccessToken);

    // 2. Find or create user
    const { data: existingUser } = await adminClient
      .from('users')
      .select('id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month')
      .eq('google_oauth_id', googleUser.sub)
      .maybeSingle();

    let user = existingUser;

    if (!user) {
      // Check if a user exists with this email but no Google link
      const { data: emailUser } = await adminClient
        .from('users')
        .select('id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month')
        .eq('email', googleUser.email)
        .maybeSingle();

      if (emailUser) {
        // Link Google account to existing user
        await adminClient
          .from('users')
          .update({ google_oauth_id: googleUser.sub, name: emailUser.name || googleUser.name })
          .eq('id', emailUser.id);
        user = emailUser;
      } else {
        // Create new user
        const { data: newUser, error: createError } = await adminClient
          .from('users')
          .insert({
            email: googleUser.email,
            name: googleUser.name,
            google_oauth_id: googleUser.sub,
          })
          .select('id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month')
          .single();

        if (createError || !newUser) {
          console.error('User creation failed:', createError?.message);
          return new Response(
            JSON.stringify({ error: 'Failed to create user account' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        user = newUser;
      }
    }

    // 3. Create session
    const tier = user.subscription_tier as 'free' | 'pro';
    const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    // Generate tokens first so we can hash the refresh token for storage
    const sessionId = crypto.randomUUID();
    const accessToken = await createAccessToken({
      userId: user.id,
      email: user.email,
      tier,
      sessionId,
    });
    const refreshToken = await createRefreshToken({
      userId: user.id,
      email: user.email,
      tier,
      sessionId,
    });

    const tokenHash = await hashToken(refreshToken);

    const { error: sessionError } = await adminClient
      .from('sessions')
      .insert({
        id: sessionId,
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: sessionExpiresAt.toISOString(),
      });

    if (sessionError) {
      console.error('Session creation failed:', sessionError.message);
      return new Response(
        JSON.stringify({ error: 'Failed to create session' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // 4. Return tokens and user info
    return new Response(
      JSON.stringify({
        accessToken,
        refreshToken,
        expiresAt: sessionExpiresAt.toISOString(),
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier,
          credits: {
            used: user.credits_used,
            limit: user.credits_limit,
            resetMonth: user.credits_reset_month,
          },
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Auth error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Authentication failed' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
