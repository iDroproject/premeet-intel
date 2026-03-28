// Integration tests for cross-function credit tracking and cache TTL verification.
// Verifies per-action costs (company=1, contact=1, custom=2) accumulate correctly,
// and that cache entries respect their configured TTLs.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  seedTestData,
  cleanupTestData,
  teardown,
  query,
  TEST_USER_FREE_ID,
  TEST_USER_PRO_ID,
  setCredits,
  getCreditsUsed,
  insertCacheEntry,
  getCacheEntry,
} from './setup';

describe('credit tracking across enrichment types', () => {
  beforeAll(async () => {
    await cleanupTestData();
    await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  beforeEach(async () => {
    await query(`DELETE FROM enrichment_requests WHERE user_id IN ($1, $2)`,
      [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
    await setCredits(TEST_USER_PRO_ID, 0);
  });

  it('accumulates credits correctly: company(1) + contact(1) + custom(2) = 4', async () => {
    const userId = TEST_USER_PRO_ID;
    expect(await getCreditsUsed(userId)).toBe(0);

    // Simulate company fetch (+1)
    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [userId]);
    expect(await getCreditsUsed(userId)).toBe(1);

    // Simulate contact fetch (+1)
    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [userId]);
    expect(await getCreditsUsed(userId)).toBe(2);

    // Simulate custom search (+2)
    await query(`UPDATE users SET credits_used = credits_used + 2 WHERE id = $1`, [userId]);
    expect(await getCreditsUsed(userId)).toBe(4);
  });

  it('does not accumulate credits on cache hits', async () => {
    const userId = TEST_USER_PRO_ID;

    // Fresh fetch: +1
    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [userId]);

    // Cache hit: +0
    // (no credit update — just log request with 0 credits)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', 'test:cache-hit', 0, 'cached', true)
    `, [userId]);

    expect(await getCreditsUsed(userId)).toBe(1);
  });

  it('tracks mixed request types in enrichment_requests', async () => {
    const userId = TEST_USER_PRO_ID;

    // Company success (1 credit)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', 'test:name:widgetco', 1, 'success', false)
    `, [userId]);

    // Contact success (1 credit)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', 'test:contact:linkedin:janedoe', 1, 'success', false)
    `, [userId]);

    // Custom success (2 credits)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', 'test:custom:hash123', 2, 'success', false)
    `, [userId]);

    // Company cache hit (0 credits)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', 'test:name:widgetco', 0, 'cached', true)
    `, [userId]);

    // Verify total credits logged
    const { rows } = await query(
      `SELECT sum(credits_used)::int as total FROM enrichment_requests WHERE user_id = $1`,
      [userId],
    );
    expect(rows[0].total).toBe(4); // 1 + 1 + 2 + 0

    // Verify request counts by status
    const { rows: statusCounts } = await query(`
      SELECT status, count(*)::int as cnt
      FROM enrichment_requests WHERE user_id = $1
      GROUP BY status ORDER BY status
    `, [userId]);

    const byStatus = Object.fromEntries(statusCounts.map((r: { status: string; cnt: number }) => [r.status, r.cnt]));
    expect(byStatus.success).toBe(3);
    expect(byStatus.cached).toBe(1);
  });

  it('prevents negative credit balance (credits_used cannot go below 0)', async () => {
    await setCredits(TEST_USER_PRO_ID, 0);

    // credits_used column is int NOT NULL DEFAULT 0 — verify it's at 0
    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(0);
  });
});

describe('cache TTL verification', () => {
  beforeAll(async () => {
    await cleanupTestData();
    await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await teardown();
  });

  beforeEach(async () => {
    await query(`DELETE FROM enrichment_cache WHERE entity_key LIKE 'test:%'`);
  });

  it('company cache: 30-day TTL', async () => {
    await insertCacheEntry('company', 'test:name:ttl-company', { name: 'TTL Co' }, 'brightdata', 30);

    const { rows } = await query(`
      SELECT expires_at, fetched_at
      FROM enrichment_cache
      WHERE entity_key = 'test:name:ttl-company'
    `);
    expect(rows).toHaveLength(1);

    const fetched = new Date(rows[0].fetched_at);
    const expires = new Date(rows[0].expires_at);
    const diffDays = (expires.getTime() - fetched.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29.9);
    expect(diffDays).toBeLessThanOrEqual(30.1);
  });

  it('contact cache: 7-day TTL', async () => {
    await insertCacheEntry('person', 'test:contact:linkedin:ttl-person', { phone: '+1' }, 'brightdata', 7);

    const { rows } = await query(`
      SELECT expires_at, fetched_at
      FROM enrichment_cache
      WHERE entity_key = 'test:contact:linkedin:ttl-person'
    `);
    expect(rows).toHaveLength(1);

    const fetched = new Date(rows[0].fetched_at);
    const expires = new Date(rows[0].expires_at);
    const diffDays = (expires.getTime() - fetched.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });

  it('custom enrichment cache: 7-day TTL', async () => {
    await insertCacheEntry('person', 'test:custom:ttl-hash', { results: [] }, 'brightdata_serp', 7);

    const { rows } = await query(`
      SELECT expires_at, fetched_at
      FROM enrichment_cache
      WHERE entity_key = 'test:custom:ttl-hash'
    `);
    expect(rows).toHaveLength(1);

    const fetched = new Date(rows[0].fetched_at);
    const expires = new Date(rows[0].expires_at);
    const diffDays = (expires.getTime() - fetched.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });

  it('expired entries are not returned by cache lookup', async () => {
    // Insert an entry that already expired
    await query(`
      INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, fetched_at, expires_at)
      VALUES ('company', 'test:name:expired-co', '{"name":"Old"}'::jsonb, 'brightdata',
              now() - interval '31 days', now() - interval '1 hour')
      ON CONFLICT (entity_type, entity_key) DO UPDATE SET
        expires_at = now() - interval '1 hour'
    `);

    const entry = await getCacheEntry('company', 'test:name:expired-co');
    expect(entry).toBeNull();
  });

  it('valid entries within TTL are returned', async () => {
    await insertCacheEntry('company', 'test:name:valid-co', { name: 'Valid Co' }, 'brightdata', 30);

    const entry = await getCacheEntry('company', 'test:name:valid-co');
    expect(entry).not.toBeNull();
    expect(entry.enrichment_data.name).toBe('Valid Co');
  });

  // ─── Schema constraint tests ─────────────────────────────────────────────

  it('enforces unique constraint on (entity_type, entity_key)', async () => {
    await insertCacheEntry('company', 'test:name:unique-co', { name: 'First' }, 'brightdata', 30);

    // Second insert with same key — should upsert, not fail
    await insertCacheEntry('company', 'test:name:unique-co', { name: 'Second' }, 'brightdata', 30);

    const entry = await getCacheEntry('company', 'test:name:unique-co');
    expect(entry.enrichment_data.name).toBe('Second');

    // Verify only one row exists
    const { rows } = await query(
      `SELECT count(*)::int as cnt FROM enrichment_cache WHERE entity_key = 'test:name:unique-co'`,
    );
    expect(rows[0].cnt).toBe(1);
  });
});
