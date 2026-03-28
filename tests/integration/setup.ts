// Integration test setup — real Neon DB connection and test helpers.
// Requires NEON_DATABASE_URL env var to be set.

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const databaseUrl = process.env.NEON_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'NEON_DATABASE_URL is required for integration tests. ' +
    'Set it in your environment or .env file.'
  );
}

export const pool = new Pool({ connectionString: databaseUrl });

/** Run a parameterized query against the test database. */
export async function query(text: string, params: unknown[] = []) {
  return pool.query(text, params);
}

// ─── Test fixture IDs (deterministic UUIDs for test isolation) ────────────────

export const TEST_USER_FREE_ID = '00000000-0000-4000-a000-000000000001';
export const TEST_USER_PRO_ID  = '00000000-0000-4000-a000-000000000002';
export const TEST_SESSION_ID   = '00000000-0000-4000-b000-000000000001';
export const TEST_SESSION_PRO  = '00000000-0000-4000-b000-000000000002';

const currentMonth = new Date().toISOString().slice(0, 7);

/** Insert test users and sessions. Idempotent — uses ON CONFLICT. */
export async function seedTestData() {
  // Free-tier test user (10 credits)
  await query(`
    INSERT INTO users (id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month)
    VALUES ($1, 'test-free@premeet.test', 'Test Free User', 'free', 0, 10, $2)
    ON CONFLICT (id) DO UPDATE SET
      credits_used = 0,
      credits_limit = 10,
      credits_reset_month = $2,
      subscription_tier = 'free'
  `, [TEST_USER_FREE_ID, currentMonth]);

  // Pro-tier test user (100 credits)
  await query(`
    INSERT INTO users (id, email, name, subscription_tier, credits_used, credits_limit, credits_reset_month)
    VALUES ($1, 'test-pro@premeet.test', 'Test Pro User', 'pro', 0, 100, $2)
    ON CONFLICT (id) DO UPDATE SET
      credits_used = 0,
      credits_limit = 100,
      credits_reset_month = $2,
      subscription_tier = 'pro'
  `, [TEST_USER_PRO_ID, currentMonth]);

  // Sessions (expire in 24 hours)
  await query(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES ($1, $2, 'test-hash-free-001', now() + interval '24 hours')
    ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '24 hours'
  `, [TEST_SESSION_ID, TEST_USER_FREE_ID]);

  await query(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at)
    VALUES ($1, $2, 'test-hash-pro-001', now() + interval '24 hours')
    ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '24 hours'
  `, [TEST_SESSION_PRO, TEST_USER_PRO_ID]);
}

/** Remove all test data by known IDs. */
export async function cleanupTestData() {
  // Delete in dependency order
  await query(`DELETE FROM enrichment_requests WHERE user_id IN ($1, $2)`,
    [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
  // enrichment_prompts may not exist if schema 002 hasn't been applied
  await query(`DELETE FROM enrichment_prompts WHERE user_id IN ($1, $2)`,
    [TEST_USER_FREE_ID, TEST_USER_PRO_ID]).catch(() => {});
  await query(`DELETE FROM enrichment_cache WHERE entity_key LIKE 'test:%'`);
  await query(`DELETE FROM cache_stats WHERE date = CURRENT_DATE AND entity_type IN ('company', 'person')`);
  await query(`DELETE FROM sessions WHERE id IN ($1, $2)`,
    [TEST_SESSION_ID, TEST_SESSION_PRO]);
  await query(`DELETE FROM users WHERE id IN ($1, $2)`,
    [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
}

/** Reset a test user's credits to a specific value. */
export async function setCredits(userId: string, used: number) {
  await query(`UPDATE users SET credits_used = $1 WHERE id = $2`, [used, userId]);
}

/** Get a user's current credits_used. */
export async function getCreditsUsed(userId: string): Promise<number> {
  const { rows } = await query(`SELECT credits_used FROM users WHERE id = $1`, [userId]);
  return rows[0]?.credits_used ?? 0;
}

/** Insert a cache entry with a specified TTL. */
export async function insertCacheEntry(
  entityType: string,
  entityKey: string,
  data: object,
  source: string,
  ttlDays: number,
) {
  await query(`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ($1::entity_type, $2, $3::jsonb, $4, now() + make_interval(days => $5))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = $3::jsonb,
      source = $4,
      fetched_at = now(),
      expires_at = now() + make_interval(days => $5)
  `, [entityType, entityKey, JSON.stringify(data), source, ttlDays]);
}

/** Insert an expired cache entry (for TTL tests). */
export async function insertExpiredCacheEntry(
  entityType: string,
  entityKey: string,
  data: object,
  source: string,
) {
  await query(`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, fetched_at, expires_at)
    VALUES ($1::entity_type, $2, $3::jsonb, $4, now() - interval '31 days', now() - interval '1 day')
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = $3::jsonb,
      source = $4,
      fetched_at = now() - interval '31 days',
      expires_at = now() - interval '1 day'
  `, [entityType, entityKey, JSON.stringify(data), source]);
}

/** Query cache entry by type and key. Returns null if not found or expired. */
export async function getCacheEntry(entityType: string, entityKey: string) {
  const { rows } = await query(`
    SELECT enrichment_data, fetched_at, expires_at
    FROM enrichment_cache
    WHERE entity_type = $1::entity_type AND entity_key = $2 AND expires_at > now()
    LIMIT 1
  `, [entityType, entityKey]);
  return rows[0] ?? null;
}

/** Count enrichment requests for a user with a given status. */
export async function countRequests(userId: string, status?: string): Promise<number> {
  if (status) {
    const { rows } = await query(
      `SELECT count(*)::int as cnt FROM enrichment_requests WHERE user_id = $1 AND status = $2::enrichment_status`,
      [userId, status],
    );
    return rows[0].cnt;
  }
  const { rows } = await query(
    `SELECT count(*)::int as cnt FROM enrichment_requests WHERE user_id = $1`,
    [userId],
  );
  return rows[0].cnt;
}

/** Get cache stats for today and a given entity type. */
export async function getCacheStats(entityType: string) {
  const { rows } = await query(`
    SELECT hits, misses FROM cache_stats
    WHERE date = CURRENT_DATE AND entity_type = $1::entity_type
    LIMIT 1
  `, [entityType]);
  return rows[0] ?? null;
}

/** Tear down the pool (call in afterAll). */
export async function teardown() {
  await pool.end();
}
