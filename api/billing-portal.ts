// PreMeet — Create Stripe Customer Portal Session
// POST /api/billing-portal
//
// Creates a Stripe Customer Portal session for self-service subscription management.
// Request body: { returnUrl: string }

export const config = { runtime: 'edge' };

import { corsHeaders, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { requireAuth } from './_shared/auth-middleware';
import { stripe } from './_shared/stripe';

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

  const { userId } = auth.context;

  let body: { returnUrl: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body.returnUrl) {
    return new Response(JSON.stringify({ error: 'returnUrl is required.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Look up user's Stripe customer ID
  const subs = await sql`
    SELECT stripe_customer_id FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;

  if (subs.length === 0 || !subs[0].stripe_customer_id) {
    return new Response(
      JSON.stringify({ error: 'No billing account found. Subscribe to a plan first.' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: subs[0].stripe_customer_id,
    return_url: body.returnUrl,
  });

  return new Response(
    JSON.stringify({ url: portalSession.url }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
