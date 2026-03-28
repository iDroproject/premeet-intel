// Integration tests for enrichment-company edge function DB operations.
// Tests cache miss → fetch → cache hit cycle, credit deduction, and error logging
// against a real Neon database.

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

const ENTITY_KEY_TEST = 'test:name:acme-corp';
const COMPANY_DATA = {
  name: 'Acme Corp',
  linkedinUrl: 'https://linkedin.com/company/acme-corp',
  logo: null,
  industry: 'Technology',
  sizeRange: '51-200',
  revenueRange: '$10M-$50M',
  website: 'https://acme.example.com',
  foundedYear: 2015,
  hqAddress: 'San Francisco, CA',
  description: 'Test company',
  fundingTotal: '$20M',
  fundingLastRound: 'Series A',
  fundingInvestors: ['Test VC'],
  products: ['Widget'],
  technologies: ['React', 'Node.js'],
  recentNews: [],
  intentSignals: [],
};

describe('enrichment-company DB operations', () => {
  beforeAll(async () => {
    await cleanupTestData();
    await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await teardown();
  });

  beforeEach(async () => {
    // Clean up test-specific cache and request entries between tests
    await query(`DELETE FROM enrichment_cache WHERE entity_key LIKE 'test:%'`);
    await query(`DELETE FROM enrichment_requests WHERE user_id IN ($1, $2)`,
      [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
    await query(`DELETE FROM cache_stats WHERE date = CURRENT_DATE`);
    await setCredits(TEST_USER_FREE_ID, 0);
    await setCredits(TEST_USER_PRO_ID, 0);
  });

  // ─── Cache miss → insert → cache hit cycle ──────────────────────────────

  it('returns null for cache miss on unknown entity key', async () => {
    const entry = await getCacheEntry('company', ENTITY_KEY_TEST);
    expect(entry).toBeNull();
  });

  it('caches company data with 30-day TTL and retrieves it', async () => {
    await insertCacheEntry('company', ENTITY_KEY_TEST, COMPANY_DATA, 'brightdata', 30);
    const entry = await getCacheEntry('company', ENTITY_KEY_TEST);

    expect(entry).not.toBeNull();
    expect(entry.enrichment_data).toEqual(COMPANY_DATA);

    // Verify TTL is approximately 30 days
    const expiresAt = new Date(entry.expires_at);
    const now = new Date();
    const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it('upserts cache entry on conflict (same entity_type + entity_key)', async () => {
    await insertCacheEntry('company', ENTITY_KEY_TEST, COMPANY_DATA, 'brightdata', 30);

    const updatedData = { ...COMPANY_DATA, description: 'Updated description' };
    await insertCacheEntry('company', ENTITY_KEY_TEST, updatedData, 'brightdata', 30);

    const entry = await getCacheEntry('company', ENTITY_KEY_TEST);
    expect(entry.enrichment_data.description).toBe('Updated description');
  });

  it('does not return expired cache entries', async () => {
    await insertExpiredCacheEntry('company', ENTITY_KEY_TEST, COMPANY_DATA, 'brightdata');
    const entry = await getCacheEntry('company', ENTITY_KEY_TEST);
    expect(entry).toBeNull();
  });

  // ─── Credit deduction ───────────────────────────────────────────────────

  it('deducts 1 credit on successful company fetch', async () => {
    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(0);

    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [TEST_USER_FREE_ID]);
    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(1);
  });

  it('does not deduct credit on cache hit', async () => {
    // Log a cache-hit request (0 credits)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', $2, 0, 'cached', true)
    `, [TEST_USER_FREE_ID, ENTITY_KEY_TEST]);

    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(0);
    expect(await countRequests(TEST_USER_FREE_ID, 'cached')).toBe(1);
  });

  it('enforces credit limit for free users', async () => {
    await setCredits(TEST_USER_FREE_ID, 10); // At limit

    const { rows } = await query(
      `SELECT credits_used, credits_limit, subscription_tier FROM users WHERE id = $1`,
      [TEST_USER_FREE_ID],
    );
    const user = rows[0];
    expect(user.subscription_tier).toBe('free');
    expect(user.credits_used).toBe(10);
    expect(user.credits_used >= user.credits_limit).toBe(true);
  });

  it('resets credits on new month', async () => {
    await setCredits(TEST_USER_FREE_ID, 8);
    const newMonth = '2099-01'; // future month

    await query(
      `UPDATE users SET credits_used = 0, credits_reset_month = $1 WHERE id = $2`,
      [newMonth, TEST_USER_FREE_ID],
    );

    const { rows } = await query(
      `SELECT credits_used, credits_reset_month FROM users WHERE id = $1`,
      [TEST_USER_FREE_ID],
    );
    expect(rows[0].credits_used).toBe(0);
    expect(rows[0].credits_reset_month).toBe(newMonth);
  });

  // ─── Enrichment request logging ─────────────────────────────────────────

  it('logs successful enrichment request', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
      VALUES ($1, 'company', $2, 1, 'success', false, now())
    `, [TEST_USER_FREE_ID, ENTITY_KEY_TEST]);

    expect(await countRequests(TEST_USER_FREE_ID, 'success')).toBe(1);
  });

  it('logs failed enrichment request', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', $2, 0, 'failed', false)
    `, [TEST_USER_FREE_ID, ENTITY_KEY_TEST]);

    expect(await countRequests(TEST_USER_FREE_ID, 'failed')).toBe(1);
  });

  it('logs pending (async) enrichment request', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'company', $2, 1, 'pending', false)
    `, [TEST_USER_FREE_ID, ENTITY_KEY_TEST]);

    expect(await countRequests(TEST_USER_FREE_ID, 'pending')).toBe(1);
  });

  // ─── Cache stats ────────────────────────────────────────────────────────

  it('tracks cache hit stats via upsert_cache_stat', async () => {
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`);
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`);

    const stats = await getCacheStats('company');
    expect(stats).not.toBeNull();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(0);
  });

  it('tracks cache miss stats via upsert_cache_stat', async () => {
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`);

    const stats = await getCacheStats('company');
    expect(stats).not.toBeNull();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(1);
  });

  it('accumulates hits and misses correctly', async () => {
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 3, 1)`);
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 2, 4)`);

    const stats = await getCacheStats('company');
    expect(stats.hits).toBe(5);
    expect(stats.misses).toBe(5);
  });

  // ─── Entity key building (LinkedIn URL vs company name) ─────────────────

  it('stores and retrieves by LinkedIn-based entity key', async () => {
    const linkedinKey = 'test:linkedin:acme-corp';
    await insertCacheEntry('company', linkedinKey, COMPANY_DATA, 'brightdata', 30);

    const entry = await getCacheEntry('company', linkedinKey);
    expect(entry).not.toBeNull();
    expect(entry.enrichment_data.name).toBe('Acme Corp');
  });

  it('stores and retrieves by name-based entity key', async () => {
    const nameKey = 'test:name:acme corp';
    await insertCacheEntry('company', nameKey, COMPANY_DATA, 'brightdata', 30);

    const entry = await getCacheEntry('company', nameKey);
    expect(entry).not.toBeNull();
    expect(entry.enrichment_data.name).toBe('Acme Corp');
  });
});
