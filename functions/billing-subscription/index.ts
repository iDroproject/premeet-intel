// PreMeet — Get Current Subscription Status
// GET /functions/v1/billing-subscription
//
// Returns the authenticated user's subscription details.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { sql } from '../_shared/db.ts';
import { requireAuth } from '../_shared/auth-middleware.ts';

serve(async (req: Request) => {
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
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
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
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
