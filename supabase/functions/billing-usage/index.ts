// PreMeet — Get Current Period Usage
// GET /functions/v1/billing-usage
//
// Returns the authenticated user's enrichment credit usage for the current billing period.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, corsResponse } from '../_shared/cors.ts';
import { adminClient } from '../_shared/db.ts';
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

  // Get user's current credits
  const { data: user, error: userError } = await adminClient
    .from('users')
    .select('credits_used, credits_limit, credits_reset_month, subscription_tier')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Get subscription period info if available
  const { data: subscription } = await adminClient
    .from('subscriptions')
    .select('current_period_start, current_period_end')
    .eq('user_id', userId)
    .single();

  // Count enrichment requests in current period
  const periodStart = subscription?.current_period_start
    ?? `${user.credits_reset_month}-01T00:00:00Z`;

  const { count: requestCount } = await adminClient
    .from('enrichment_requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('requested_at', periodStart);

  return new Response(
    JSON.stringify({
      usage: {
        tier: user.subscription_tier,
        creditsUsed: user.credits_used,
        creditsLimit: user.credits_limit,
        resetMonth: user.credits_reset_month,
        enrichmentRequests: requestCount ?? 0,
        currentPeriod: {
          start: subscription?.current_period_start ?? null,
          end: subscription?.current_period_end ?? null,
        },
      },
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
