// PreMeet credit system
// Tracks per-user enrichment usage against the freemium plan limit.
// Stored in chrome.storage.local; will be synced to Supabase when ready.

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
