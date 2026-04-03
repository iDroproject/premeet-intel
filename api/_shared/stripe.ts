// Shared Stripe client for PreMeet Edge Functions.
// Uses the Stripe API key from environment variables.

import Stripe from 'stripe';

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const stripeApiKey = process.env.STRIPE_API_KEY;
    if (!stripeApiKey) {
      throw new Error('STRIPE_API_KEY is not set.');
    }
    _stripe = new Stripe(stripeApiKey, {
      // @ts-expect-error — pin to the API version our schema uses
      apiVersion: '2025-02-24.acacia',
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return _stripe;
}

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const instance = getStripe();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
});

// Subscription tier config: Stripe Price IDs mapped to tiers
export const TIER_CONFIG: Record<string, { creditsLimit: number; priceId?: string }> = {
  free: {
    creditsLimit: 10,
  },
  pro: {
    creditsLimit: 100,
    get priceId() { return process.env.STRIPE_PRO_PRICE_ID ?? ''; },
  },
  enterprise: {
    creditsLimit: -1, // unlimited
    get priceId() { return process.env.STRIPE_ENTERPRISE_PRICE_ID ?? ''; },
  },
};

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
