// PreMeet — Get Current User Profile
// GET /functions/v1/auth-me
//
// Returns the authenticated user's profile, credit usage, and tier info.

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

  const { data: user, error } = await adminClient
    .from('users')
    .select('id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month, created_at')
    .eq('id', userId)
    .single();

  if (error || !user) {
    return new Response(
      JSON.stringify({ error: 'User not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Auto-reset credits if we're in a new month
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (user.credits_reset_month !== currentMonth) {
    await adminClient
      .from('users')
      .update({ credits_used: 0, credits_reset_month: currentMonth })
      .eq('id', userId);
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
});
