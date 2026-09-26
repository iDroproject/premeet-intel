// PreMeet — Scheduled cleanup
// GET /api/cron-cleanup
//
// Purges long-expired cache entries, expired sessions, and old rate-limit rows
// so those tables don't grow unbounded. Invoked by a Vercel Cron (see
// vercel.json). Protected by CRON_SECRET: Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>`.

export const config = { runtime: 'edge' };

import { sql } from './_shared/db';

export default async function handler(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  // Only allow when a secret is configured AND matches. Never run unauthenticated.
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: 'Not authorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const rows = await sql`SELECT * FROM purge_expired()`;
    const result = rows[0] ?? {};
    console.log('[cron-cleanup] purged', result);
    return new Response(JSON.stringify({ ok: true, purged: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[cron-cleanup] failed:', (err as Error).message);
    return new Response(JSON.stringify({ error: 'Cleanup failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
