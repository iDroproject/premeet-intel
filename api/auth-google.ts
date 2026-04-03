// PreMeet — Google OAuth Token Exchange
// POST /api/auth-google
//
// The Chrome extension obtains a Google access token via chrome.identity,
// then sends it here. We verify the token with Google, create or find
// the user, create a session, and return access + refresh tokens.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { createAccessToken, createRefreshToken, hashToken } from './_shared/jwt';

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

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = corsHeadersFor(req);

  if (req.method === 'OPTIONS') return corsResponse(req);

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

    // Validate that the required identity fields are present in the Google response
    if (!googleUser.sub || typeof googleUser.sub !== 'string' || googleUser.sub.trim() === '') {
      throw new Error('Google token response missing required field: sub');
    }
    if (!googleUser.email || typeof googleUser.email !== 'string' || !googleUser.email.includes('@')) {
      throw new Error('Google token response missing required field: email');
    }

    // 2. Find or create user
    const existing = await sql`
      SELECT id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month
      FROM users WHERE google_oauth_id = ${googleUser.sub} LIMIT 1
    `;

    let user = existing[0] ?? null;

    if (!user) {
      // Check if a user exists with this email but no Google link
      const emailUsers = await sql`
        SELECT id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month
        FROM users WHERE email = ${googleUser.email} LIMIT 1
      `;

      if (emailUsers.length > 0) {
        // Link Google account to existing user
        await sql`
          UPDATE users SET google_oauth_id = ${googleUser.sub}, name = COALESCE(${emailUsers[0].name}, ${googleUser.name})
          WHERE id = ${emailUsers[0].id}
        `;
        user = emailUsers[0];
      } else {
        // Create new user
        const newUsers = await sql`
          INSERT INTO users (email, name, google_oauth_id)
          VALUES (${googleUser.email}, ${googleUser.name}, ${googleUser.sub})
          RETURNING id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month
        `;

        if (newUsers.length === 0) {
          console.error('User creation failed: no rows returned');
          return new Response(
            JSON.stringify({ error: 'Failed to create user account' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
        user = newUsers[0];
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

    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${sessionId}, ${user.id}, ${tokenHash}, ${sessionExpiresAt.toISOString()})
    `;

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
}
