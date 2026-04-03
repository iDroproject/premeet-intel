// PreMeet — Stripe Webhook Handler
// POST /api/stripe-webhook
//
// Handles Stripe webhook events for subscription lifecycle management.
// No auth middleware — uses Stripe webhook signature verification instead.

export const config = { runtime: 'edge' };

import { corsHeaders } from './_shared/cors';
import { sql } from './_shared/db';
import { stripe, priceIdToTier, creditsLimitForTier } from './_shared/stripe';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

export default async function handler(req: Request): Promise<Response> {
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
  try {
    await sql`
      INSERT INTO billing_events (stripe_event_id, event_type, user_id, data)
      VALUES (${event.id}, ${event.type}, ${userId}, ${JSON.stringify(event.data.object)})
      ON CONFLICT (stripe_event_id) DO NOTHING
    `;
  } catch (err) {
    console.error('Failed to log billing event:', (err as Error).message);
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
}

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
  const periodStart = new Date((subscription as any).current_period_start * 1000).toISOString();
  const periodEnd = new Date((subscription as any).current_period_end * 1000).toISOString();

  await sql`
    INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, tier, status, current_period_start, current_period_end, cancel_at_period_end)
    VALUES (${userId}, ${customerId}, ${subscriptionId}, ${tier}, ${subscription.status}, ${periodStart}, ${periodEnd}, ${subscription.cancel_at_period_end})
    ON CONFLICT (user_id) DO UPDATE SET
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      tier = EXCLUDED.tier,
      status = EXCLUDED.status,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end
  `;

  // Update user's subscription tier and credit limit
  const creditsLimit = creditsLimitForTier(tier);
  await sql`
    UPDATE users SET subscription_tier = ${tier}, credits_limit = ${creditsLimit === -1 ? 999999 : creditsLimit}
    WHERE id = ${userId}
  `;
}

/** Handle customer.subscription.updated — sync tier/status changes */
async function handleSubscriptionUpdated(subscription: any) {
  const userId = subscription.metadata?.premeet_user_id;
  if (!userId) return;

  const priceId = subscription.items.data[0]?.price?.id ?? '';
  const tier = priceIdToTier(priceId);
  const periodStart = new Date((subscription as any).current_period_start * 1000).toISOString();
  const periodEnd = new Date((subscription as any).current_period_end * 1000).toISOString();

  await sql`
    UPDATE subscriptions SET
      tier = ${tier},
      status = ${subscription.status},
      current_period_start = ${periodStart},
      current_period_end = ${periodEnd},
      cancel_at_period_end = ${subscription.cancel_at_period_end}
    WHERE stripe_subscription_id = ${subscription.id}
  `;

  // Sync tier to users table
  const creditsLimit = creditsLimitForTier(tier);
  await sql`
    UPDATE users SET subscription_tier = ${tier}, credits_limit = ${creditsLimit === -1 ? 999999 : creditsLimit}
    WHERE id = ${userId}
  `;
}

/** Handle customer.subscription.deleted — revert to free tier */
async function handleSubscriptionDeleted(subscription: any) {
  const userId = subscription.metadata?.premeet_user_id;
  if (!userId) return;

  await sql`
    UPDATE subscriptions SET status = 'canceled', tier = 'free'
    WHERE stripe_subscription_id = ${subscription.id}
  `;

  // Revert user to free tier
  await sql`
    UPDATE users SET subscription_tier = 'free', credits_limit = 10
    WHERE id = ${userId}
  `;
}

/** Handle invoice.payment_failed — mark subscription as past_due */
async function handlePaymentFailed(invoice: any) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  await sql`
    UPDATE subscriptions SET status = 'past_due'
    WHERE stripe_subscription_id = ${subscriptionId}
  `;
}
