// PreMeet credit system
// Tracks per-user enrichment usage against the freemium plan limit.
// Stored in chrome.storage.local; will be synced to Neon when the backend API is ready.

import type { Credits, Plan } from '../types';

const STORAGE_KEY = 'pm_credits';
const FREE_LIMIT = 10;
const PRO_LIMIT = Infinity;

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function defaultCredits(plan: Plan = 'free'): Credits {
  return {
    plan,
    used: 0,
    limit: plan === 'free' ? FREE_LIMIT : PRO_LIMIT,
    resetMonth: currentMonth(),
  };
}

export async function getCredits(): Promise<Credits> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  let credits: Credits = result[STORAGE_KEY] ?? defaultCredits();

  // Reset if new month
  if (credits.resetMonth !== currentMonth()) {
    credits = { ...credits, used: 0, resetMonth: currentMonth() };
    await chrome.storage.local.set({ [STORAGE_KEY]: credits });
  }

  return credits;
}

export async function hasCredit(): Promise<boolean> {
  const credits = await getCredits();
  return credits.plan === 'pro' || credits.used < credits.limit;
}

/** Decrement one credit. Returns the updated Credits. */
export async function useCredit(): Promise<Credits> {
  const credits = await getCredits();
  const updated: Credits = { ...credits, used: credits.used + 1 };
  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
  return updated;
}

export function remainingCredits(credits: Credits): number {
  if (credits.plan === 'pro') return Infinity;
  return Math.max(0, credits.limit - credits.used);
}

/**
 * Overwrite the local credit store with the server's authoritative tier + usage.
 * The server (Neon) is the source of truth — without this, a paying subscriber
 * stays pinned at the local free default (10 credits) forever. Called on sign-in
 * and whenever we refresh the user from /auth-me.
 */
export async function syncCreditsFromServer(user: {
  tier: string;
  credits?: { used?: number; limit?: number; resetMonth?: string };
}): Promise<Credits> {
  const plan: Plan = user.tier === 'free' ? 'free' : 'pro';
  const serverCredits = user.credits ?? {};
  const credits: Credits = {
    plan,
    used: typeof serverCredits.used === 'number' ? serverCredits.used : 0,
    limit: typeof serverCredits.limit === 'number' ? serverCredits.limit : (plan === 'free' ? FREE_LIMIT : PRO_LIMIT),
    resetMonth: serverCredits.resetMonth || currentMonth(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: credits });
  return credits;
}
