// PreMeet — Dev-only Auth Token Endpoint
// POST /api/auth-dev
//
// Issues a valid JWT for testing without going through Google OAuth.
// ONLY works when PREMEET_DEV_AUTH=1 env var is set — must NEVER be
// enabled in production. Returns 404 otherwise (as if the route
// doesn't exist).
//
// Request body:
//   { "email": string, "tier?": "free" | "pro" | "enterprise" }
//
// Returns: { accessToken, user: { id, email, tier, sessionId } }

export const config = { runtime: 'edge' };

import { createAccessToken } from './_shared/jwt';
import { sql } from './_shared/db';

export default async function handler(req: Request): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  // ── Gate: only available when explicitly enabled ──────────────
  if (process.env.PREMEET_DEV_AUTH !== '1') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers,
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers,
    });
  }

  try {
    const body = await req.json();
    const email: string = body.email;
    const tier: 'free' | 'pro' | 'enterprise' = body.tier || 'pro';

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers },
      );
    }

    // Find or create a dev user
    let users = await sql`
      SELECT id, email, subscription_tier FROM users WHERE email = ${email} LIMIT 1
    `;

    if (users.length === 0) {
      users = await sql`
        INSERT INTO users (email, name, subscription_tier)
        VALUES (${email}, ${'Dev User'}, ${tier})
        RETURNING id, email, subscription_tier
      `;
    }

    const user = users[0];

    // Create a session
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await sql`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (${sessionId}, ${user.id}, ${`dev-${sessionId}`}, ${expiresAt.toISOString()})
    `;

    // Issue JWT
    const accessToken = await createAccessToken({
      userId: user.id,
      email: user.email,
      tier: (user.subscription_tier as 'free' | 'pro' | 'enterprise') || tier,
      sessionId,
    });

    return new Response(
      JSON.stringify({
        accessToken,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: user.id,
          email: user.email,
          tier: user.subscription_tier || tier,
          sessionId,
        },
      }),
      { status: 200, headers },
    );
  } catch (err) {
    console.error('Dev auth error:', (err as Error).message);
    return new Response(
      JSON.stringify({ error: 'Dev auth failed' }),
      { status: 500, headers },
    );
  }
}
