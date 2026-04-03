// PreMeet — Get Current Period Usage
// GET /api/billing-usage
//
// Returns the authenticated user's enrichment credit usage for the current billing period.

export const config = { runtime: 'edge' };

import { corsHeadersFor, corsResponse } from './_shared/cors';
import { sql } from './_shared/db';
import { requireAuth } from './_shared/auth-middleware';

export default async function handler(req: Request): Promise<Response> {
  const cors = corsHeadersFor(req);
  if (req.method === 'OPTIONS') return corsResponse(req);

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { userId } = auth.context;

  // Get user's current credits
  const users = await sql`
    SELECT credits_used, credits_limit, credits_reset_month, subscription_tier
    FROM users WHERE id = ${userId} LIMIT 1
  `;

  if (users.length === 0) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const user = users[0];

  // Get subscription period info if available
  const subs = await sql`
    SELECT current_period_start, current_period_end
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;

  const subscription = subs[0] ?? null;

  // Count enrichment requests in current period
  const periodStart = subscription?.current_period_start
    ?? `${user.credits_reset_month}-01T00:00:00Z`;

  const countResult = await sql`
    SELECT COUNT(*) as count FROM enrichment_requests
    WHERE user_id = ${userId} AND requested_at >= ${periodStart}
  `;

  const requestCount = parseInt(countResult[0]?.count ?? '0', 10);

  return new Response(
    JSON.stringify({
      usage: {
        tier: user.subscription_tier,
        creditsUsed: user.credits_used,
        creditsLimit: user.credits_limit,
        resetMonth: user.credits_reset_month,
        enrichmentRequests: requestCount,
        currentPeriod: {
          start: subscription?.current_period_start ?? null,
          end: subscription?.current_period_end ?? null,
        },
      },
    }),
    { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } },
  );
}
