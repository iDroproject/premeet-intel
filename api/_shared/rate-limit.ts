// PreMeet — Server-side per-user daily rate limit.
//
// The extension's client-side waterfall reaches BrightData through
// /api/enrichment-proxy, so the only authoritative place to bound how much a
// single user can spend on the owner's BrightData account is server-side. This
// is an anti-abuse ceiling (not the billing gate — credits handle that): it caps
// the number of *billable trigger operations* a user can start per day.
//
// Counts are stored in api_rate_limits (see neon/schema/004_*). The increment is
// a single atomic statement so concurrent requests cannot race past the cap.

import { sql } from './db';

/** Daily cap on billable BrightData trigger operations, by tier. */
export const DAILY_OP_CAP: Record<string, number> = {
  free: 200,
  pro: 2000,
  enterprise: Number.MAX_SAFE_INTEGER,
};

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  cap: number;
}

/**
 * Atomically record one billable operation for `userId` and report whether it is
 * within the tier's daily cap. Returns allowed=false (without incrementing past
 * the cap) when the user is already at the limit.
 */
export async function recordAndCheckOp(userId: string, tier: string): Promise<RateLimitResult> {
  const cap = DAILY_OP_CAP[tier] ?? DAILY_OP_CAP.free;
  if (cap >= Number.MAX_SAFE_INTEGER) {
    // Enterprise: unlimited — still record for observability, never block.
    await sql`
      INSERT INTO api_rate_limits (user_id, window_date, op_count)
      VALUES (${userId}, current_date, 1)
      ON CONFLICT (user_id, window_date)
      DO UPDATE SET op_count = api_rate_limits.op_count + 1
    `.catch(() => {});
    return { allowed: true, count: 0, cap };
  }

  // Insert-or-increment, but only increment while strictly under the cap. When
  // the row already sits at/above the cap the WHERE fails, no row is updated,
  // and RETURNING yields nothing → over limit.
  const rows = await sql`
    INSERT INTO api_rate_limits (user_id, window_date, op_count)
    VALUES (${userId}, current_date, 1)
    ON CONFLICT (user_id, window_date)
    DO UPDATE SET op_count = api_rate_limits.op_count + 1
    WHERE api_rate_limits.op_count < ${cap}
    RETURNING op_count
  `;

  if (rows.length > 0) {
    return { allowed: true, count: Number(rows[0].op_count), cap };
  }
  return { allowed: false, count: cap, cap };
}
