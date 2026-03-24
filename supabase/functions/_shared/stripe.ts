// Shared Stripe client for PreMeet Edge Functions.
// Uses the Stripe API key from environment variables.

import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno';

const stripeApiKey = Deno.env.get('STRIPE_API_KEY')!;

export const stripe = new Stripe(stripeApiKey, {
  apiVersion: '2025-02-24.acacia',
  httpClient: Stripe.createFetchHttpClient(),
});

// Subscription tier config: Stripe Price IDs mapped to tiers
export const TIER_CONFIG = {
  free: {
    creditsLimit: 10,
  },
  pro: {
    creditsLimit: 100,
    priceId: Deno.env.get('STRIPE_PRO_PRICE_ID') ?? '',
  },
  enterprise: {
    creditsLimit: -1, // unlimited
    priceId: Deno.env.get('STRIPE_ENTERPRISE_PRICE_ID') ?? '',
  },
} as const;

export type TierName = keyof typeof TIER_CONFIG;

/** Map a Stripe Price ID to a PreMeet tier name */
export function priceIdToTier(priceId: string): TierName {
  if (priceId === TIER_CONFIG.pro.priceId) return 'pro';
  if (priceId === TIER_CONFIG.enterprise.priceId) return 'enterprise';
  return 'free';
}

/** Get the credit limit for a given tier */
export function creditsLimitForTier(tier: TierName): number {
  return TIER_CONFIG[tier].creditsLimit;
}
