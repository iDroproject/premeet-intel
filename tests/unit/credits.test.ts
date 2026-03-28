import { describe, it, expect } from 'vitest';
import { remainingCredits } from '../../src/utils/credits';
import type { Credits } from '../../src/types';

// Note: getCredits, hasCredit, useCredit depend on chrome.storage.local
// and are tested via integration tests. remainingCredits is a pure function.

describe('remainingCredits', () => {
  it('returns remaining for free plan with some usage', () => {
    const credits: Credits = { plan: 'free', used: 3, limit: 10, resetMonth: '2026-03' };
    expect(remainingCredits(credits)).toBe(7);
  });

  it('returns 0 when free plan is fully used', () => {
    const credits: Credits = { plan: 'free', used: 10, limit: 10, resetMonth: '2026-03' };
    expect(remainingCredits(credits)).toBe(0);
  });

  it('returns 0 (not negative) when free plan exceeds limit', () => {
    const credits: Credits = { plan: 'free', used: 15, limit: 10, resetMonth: '2026-03' };
    expect(remainingCredits(credits)).toBe(0);
  });

  it('returns Infinity for pro plan', () => {
    const credits: Credits = { plan: 'pro', used: 100, limit: Infinity, resetMonth: '2026-03' };
    expect(remainingCredits(credits)).toBe(Infinity);
  });

  it('returns full limit when nothing used', () => {
    const credits: Credits = { plan: 'free', used: 0, limit: 10, resetMonth: '2026-03' };
    expect(remainingCredits(credits)).toBe(10);
  });
});
