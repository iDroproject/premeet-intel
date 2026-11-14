// PreMeet — Server-side credit accounting (atomic, race-safe).
//
// Replaces the check-then-increment pattern that allowed concurrent requests to
// over-spend past the tier cap (TOCTOU), and enforces credits_limit uniformly
// for every tier. The monthly rollover is folded into the same statement so a
// new-month reset can never wipe a concurrently recorded charge.
//
// The enterprise tier is stored with a very large credits_limit (999999) by the
// Stripe webhook, so `used + n <= credits_limit` is effectively unlimited for it
// while still bounding free (10) and pro (100) users.

import { sql } from './db';

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Atomically reserve `n` credits for a user, enforcing the tier limit for ALL
 * tiers, and rolling the monthly counter over in the same statement.
 *
 * @returns the new credits_used on success, or null if the limit would be exceeded
 *          (or the user does not exist).
 */
export async function reserveCredits(userId: string, n: number): Promise<number | null> {
  const month = currentMonth();
  const rows = await sql`
    UPDATE users
    SET credits_used = (CASE WHEN credits_reset_month <> ${month} THEN 0 ELSE credits_used END) + ${n},
        credits_reset_month = ${month}
    WHERE id = ${userId}
      AND (CASE WHEN credits_reset_month <> ${month} THEN 0 ELSE credits_used END) + ${n} <= credits_limit
    RETURNING credits_used, credits_limit
  `;
  return rows.length > 0 ? Number(rows[0].credits_used) : null;
}

/**
 * Refund `n` credits after a failed fetch. Best-effort; never drops below 0.
 */
export async function refundCredits(userId: string, n: number): Promise<void> {
  await sql`UPDATE users SET credits_used = GREATEST(credits_used - ${n}, 0) WHERE id = ${userId}`;
}

/**
 * Idempotent, race-safe monthly rollover for read paths (e.g. /auth-me) that
 * only need the counter reset, not a charge. The second concurrent racer becomes
 * a no-op instead of wiping usage.
 */
export async function rolloverIfNeeded(userId: string): Promise<void> {
  const month = currentMonth();
  await sql`
    UPDATE users SET credits_used = 0, credits_reset_month = ${month}
    WHERE id = ${userId} AND credits_reset_month <> ${month}
  `;
}
