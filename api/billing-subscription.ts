// PreMeet — Get Current Subscription Status
// GET /api/billing-subscription
//
// Returns the authenticated user's subscription details.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { requireAuth } from './_shared/auth-middleware';

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { userId } = auth.context;

  const subs = await sql`
    SELECT tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;

  // If no subscription record, user is on free tier
  if (subs.length === 0) {
    return new Response(
      JSON.stringify({
        subscription: {
          tier: 'free',
          status: 'active',
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  }

  const subscription = subs[0];

  return new Response(
    JSON.stringify({
      subscription: {
        tier: subscription.tier,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        createdAt: subscription.created_at,
      },
    }),
    { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}
