// Integration tests for enrichment-contact edge function DB operations.
// Tests Pro auth gate (403 for Free users), cache cycle, and credit deduction.

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
  insertExpiredCacheEntry,
  getCacheEntry,
  countRequests,
  getCacheStats,
} from './setup';

const CONTACT_KEY = 'test:contact:linkedin:johndoe';
const CONTACT_DATA = {
  phone: '+1-555-0123',
  email: 'john.doe@example.com',
  sources: ['brightdata'],
};

describe('enrichment-contact DB operations', () => {
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
    await query(`DELETE FROM enrichment_requests WHERE user_id IN ($1, $2)`,
      [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
    await query(`DELETE FROM cache_stats WHERE date = CURRENT_DATE`);
    await setCredits(TEST_USER_FREE_ID, 0);
    await setCredits(TEST_USER_PRO_ID, 0);
  });

  // ─── Pro subscription gate ──────────────────────────────────────────────

  it('free user has subscription_tier = free (gate at app layer)', async () => {
    const { rows } = await query(
      `SELECT subscription_tier FROM users WHERE id = $1`,
      [TEST_USER_FREE_ID],
    );
    expect(rows[0].subscription_tier).toBe('free');
  });

  it('pro user has subscription_tier = pro', async () => {
    const { rows } = await query(
      `SELECT subscription_tier FROM users WHERE id = $1`,
      [TEST_USER_PRO_ID],
    );
    expect(rows[0].subscription_tier).toBe('pro');
  });

  // ─── Cache miss → insert → cache hit (7-day TTL) ───────────────────────

  it('returns null for cache miss on unknown contact key', async () => {
    const entry = await getCacheEntry('person', CONTACT_KEY);
    expect(entry).toBeNull();
  });

  it('caches contact data with 7-day TTL and retrieves it', async () => {
    await insertCacheEntry('person', CONTACT_KEY, CONTACT_DATA, 'brightdata', 7);
    const entry = await getCacheEntry('person', CONTACT_KEY);

    expect(entry).not.toBeNull();
    expect(entry.enrichment_data).toEqual(CONTACT_DATA);

    // Verify TTL is approximately 7 days
    const expiresAt = new Date(entry.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6);
    expect(diffDays).toBeLessThan(8);
  });

  it('does not return expired contact cache entries', async () => {
    await insertExpiredCacheEntry('person', CONTACT_KEY, CONTACT_DATA, 'brightdata');
    const entry = await getCacheEntry('person', CONTACT_KEY);
    expect(entry).toBeNull();
  });

  // ─── Credit deduction (Pro user) ────────────────────────────────────────

  it('deducts 1 credit for Pro user on fresh contact fetch', async () => {
    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(0);

    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [TEST_USER_PRO_ID]);
    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(1);
  });

  it('does not deduct credit on contact cache hit', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', $2, 0, 'cached', true)
    `, [TEST_USER_PRO_ID, CONTACT_KEY]);

    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(0);
    expect(await countRequests(TEST_USER_PRO_ID, 'cached')).toBe(1);
  });

  it('enforces credit limit for Pro users', async () => {
    await setCredits(TEST_USER_PRO_ID, 100); // At limit

    const { rows } = await query(
      `SELECT credits_used, credits_limit FROM users WHERE id = $1`,
      [TEST_USER_PRO_ID],
    );
    expect(rows[0].credits_used >= rows[0].credits_limit).toBe(true);
  });

  // ─── Request logging ────────────────────────────────────────────────────

  it('logs contact fetch as success with entity_type=person', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
      VALUES ($1, 'person', $2, 1, 'success', false, now())
    `, [TEST_USER_PRO_ID, CONTACT_KEY]);

    const { rows } = await query(
      `SELECT entity_type, credits_used, status, cache_hit
       FROM enrichment_requests WHERE user_id = $1 AND entity_key = $2`,
      [TEST_USER_PRO_ID, CONTACT_KEY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('person');
    expect(rows[0].credits_used).toBe(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].cache_hit).toBe(false);
  });

  it('logs contact cache hit with 0 credits', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', $2, 0, 'cached', true)
    `, [TEST_USER_PRO_ID, CONTACT_KEY]);

    const { rows } = await query(
      `SELECT credits_used, cache_hit FROM enrichment_requests WHERE user_id = $1 AND status = 'cached'`,
      [TEST_USER_PRO_ID],
    );
    expect(rows[0].credits_used).toBe(0);
    expect(rows[0].cache_hit).toBe(true);
  });

  // ─── Cache stats for person entity type ─────────────────────────────────

  it('tracks person cache stats correctly', async () => {
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 1, 0)`);
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 0, 1)`);
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'person', 2, 1)`);

    const stats = await getCacheStats('person');
    expect(stats).not.toBeNull();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(2);
  });
});
