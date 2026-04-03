// PreMeet — Create Stripe Checkout Session
// POST /api/billing-checkout
//
// Creates a Stripe Checkout Session for subscription signup/upgrade.
// Request body: { tier: 'pro' | 'enterprise', successUrl: string, cancelUrl: string }

export const config = { runtime: 'edge' };

import { corsHeaders, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { requireAuth } from './_shared/auth-middleware';
import { stripe, TIER_CONFIG, type TierName } from './_shared/stripe';

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return corsResponse();

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { userId, email } = auth.context;

  let body: { tier: string; successUrl: string; cancelUrl: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { tier, successUrl, cancelUrl } = body;

  if (tier !== 'pro' && tier !== 'enterprise') {
    return new Response(JSON.stringify({ error: 'Invalid tier. Must be "pro" or "enterprise".' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!successUrl || !cancelUrl) {
    return new Response(JSON.stringify({ error: 'successUrl and cancelUrl are required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const priceId = TIER_CONFIG[tier as TierName].priceId;
  if (!priceId) {
    return new Response(JSON.stringify({ error: `Price not configured for tier: ${tier}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Check if user already has a Stripe customer ID
  const subs = await sql`
    SELECT stripe_customer_id FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;

  let stripeCustomerId = subs[0]?.stripe_customer_id ?? null;

  // Create Stripe customer if none exists
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { premeet_user_id: userId },
    });
    stripeCustomerId = customer.id;
  }

  // Create Checkout Session
  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { premeet_user_id: userId, tier },
    subscription_data: {
      metadata: { premeet_user_id: userId, tier },
    },
  });

  return new Response(
    JSON.stringify({ sessionId: session.id, url: session.url }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
