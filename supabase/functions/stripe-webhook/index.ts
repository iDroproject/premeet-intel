// PreMeet — Stripe Webhook Handler
// POST /functions/v1/stripe-webhook
//
// Handles Stripe webhook events for subscription lifecycle management.
// No auth middleware — uses Stripe webhook signature verification instead.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { adminClient } from '../_shared/db.ts';
import { stripe, priceIdToTier, creditsLimitForTier } from '../_shared/stripe.ts';

const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing Stripe signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let event;
  const body = await req.text();

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Log the event for audit trail (idempotent via unique stripe_event_id)
  const userId = extractUserId(event);
  const { error: logError } = await adminClient
    .from('billing_events')
    .upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        user_id: userId,
        data: event.data.object,
      },
      { onConflict: 'stripe_event_id' },
    );

  if (logError) {
    console.error('Failed to log billing event:', logError);
  }

  // Process event
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

/** Extract premeet_user_id from event metadata */
function extractUserId(event: any): string | null {
  const obj = event.data?.object;
  return obj?.metadata?.premeet_user_id
    ?? obj?.subscription_details?.metadata?.premeet_user_id
    ?? null;
}

/** Handle checkout.session.completed — create/update subscription record */
async function handleCheckoutCompleted(session: any) {
  const userId = session.metadata?.premeet_user_id;
  if (!userId || session.mode !== 'subscription') return;

  const subscriptionId = session.subscription;
  const customerId = session.customer;

  // Fetch the full subscription to get tier and period info
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const priceId = subscription.items.data[0]?.price?.id ?? '';
  const tier = priceIdToTier(priceId);

  // Upsert subscription record
  await adminClient
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        tier,
        status: subscription.status,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        cancel_at_period_end: subscription.cancel_at_period_end,
      },
      { onConflict: 'user_id' },
    );

  // Update user's subscription tier and credit limit
  const creditsLimit = creditsLimitForTier(tier);
  await adminClient
    .from('users')
    .update({
      subscription_tier: tier,
      credits_limit: creditsLimit === -1 ? 999999 : creditsLimit,
    })
    .eq('id', userId);
}

/** Handle customer.subscription.updated — sync tier/status changes */
async function handleSubscriptionUpdated(subscription: any) {
  const userId = subscription.metadata?.premeet_user_id;
  if (!userId) return;

  const priceId = subscription.items.data[0]?.price?.id ?? '';
  const tier = priceIdToTier(priceId);

  await adminClient
    .from('subscriptions')
    .update({
      tier,
      status: subscription.status,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
    })
    .eq('stripe_subscription_id', subscription.id);

  // Sync tier to users table
  const creditsLimit = creditsLimitForTier(tier);
  await adminClient
    .from('users')
    .update({
      subscription_tier: tier,
      credits_limit: creditsLimit === -1 ? 999999 : creditsLimit,
    })
    .eq('id', userId);
}

/** Handle customer.subscription.deleted — revert to free tier */
async function handleSubscriptionDeleted(subscription: any) {
  const userId = subscription.metadata?.premeet_user_id;
  if (!userId) return;

  await adminClient
    .from('subscriptions')
    .update({ status: 'canceled', tier: 'free' })
    .eq('stripe_subscription_id', subscription.id);

  // Revert user to free tier
  await adminClient
    .from('users')
    .update({
      subscription_tier: 'free',
      credits_limit: 10,
    })
    .eq('id', userId);
}

/** Handle invoice.payment_failed — mark subscription as past_due */
async function handlePaymentFailed(invoice: any) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  await adminClient
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', subscriptionId);
}
