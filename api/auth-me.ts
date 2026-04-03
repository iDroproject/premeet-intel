// PreMeet — Get Current User Profile
// GET /api/auth-me
//
// Returns the authenticated user's profile, credit usage, and tier info.

export const config = { runtime: 'edge' };

import { corsHeaders, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { requireAuth } from './_shared/auth-middleware';

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { userId } = auth.context;

  const users = await sql`
    SELECT id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month, created_at
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (users.length === 0) {
    return new Response(
      JSON.stringify({ error: 'User not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const user = users[0];

  // Auto-reset credits if we're in a new month
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (user.credits_reset_month !== currentMonth) {
    await sql`
      UPDATE users SET credits_used = 0, credits_reset_month = ${currentMonth}
      WHERE id = ${userId}
    `;
    user.credits_used = 0;
    user.credits_reset_month = currentMonth;
  }

  return new Response(
    JSON.stringify({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        tier: user.subscription_tier,
        credits: {
          used: user.credits_used,
          limit: user.credits_limit,
          resetMonth: user.credits_reset_month,
        },
        createdAt: user.created_at,
      },
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
