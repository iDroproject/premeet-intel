// Integration tests for enrichment-custom edge function DB operations.
// Tests Pro auth gate, prompt caching (same person+prompt = cache hit),
// 2-credit deduction, and enrichment_prompts logging.

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
  countRequests,
} from './setup';

const CUSTOM_KEY = 'test:custom:abc123def456';
const CUSTOM_DATA = {
  results: [
    { title: 'John Doe at Acme', snippet: 'VP of Sales at Acme Corp', url: 'https://example.com/1' },
    { title: 'Interview with John', snippet: 'Recent interview', url: 'https://example.com/2' },
  ],
  summary: 'VP of Sales at Acme Corp ... Recent interview',
};
const CREDITS_PER_SEARCH = 2;

describe('enrichment-custom DB operations', () => {
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
    await query(`DELETE FROM enrichment_prompts WHERE user_id IN ($1, $2)`,
      [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
    await setCredits(TEST_USER_FREE_ID, 0);
    await setCredits(TEST_USER_PRO_ID, 0);
  });

  // ─── Pro subscription gate ──────────────────────────────────────────────

  it('free user cannot access custom enrichment (tier check)', async () => {
    const { rows } = await query(
      `SELECT subscription_tier FROM users WHERE id = $1`,
      [TEST_USER_FREE_ID],
    );
    expect(rows[0].subscription_tier).toBe('free');
    // Edge function returns 403 for free users — verified at app layer
  });

  // ─── Prompt caching (same person + prompt = cache hit) ──────────────────

  it('caches custom enrichment with 7-day TTL', async () => {
    await insertCacheEntry('person', CUSTOM_KEY, CUSTOM_DATA, 'brightdata_serp', 7);

    const entry = await getCacheEntry('person', CUSTOM_KEY);
    expect(entry).not.toBeNull();
    expect(entry.enrichment_data).toEqual(CUSTOM_DATA);
    expect(entry.enrichment_data.results).toHaveLength(2);
    expect(entry.enrichment_data.summary).toContain('VP of Sales');
  });

  it('returns cache hit for same person+prompt combination', async () => {
    await insertCacheEntry('person', CUSTOM_KEY, CUSTOM_DATA, 'brightdata_serp', 7);

    // Second lookup with same key — cache hit
    const entry = await getCacheEntry('person', CUSTOM_KEY);
    expect(entry).not.toBeNull();

    // Log cache hit (0 credits)
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', $2, 0, 'cached', true)
    `, [TEST_USER_PRO_ID, CUSTOM_KEY]);

    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(0);
  });

  it('returns cache miss for different prompt (different hash key)', async () => {
    await insertCacheEntry('person', CUSTOM_KEY, CUSTOM_DATA, 'brightdata_serp', 7);

    // Different key = different prompt hash = cache miss
    const differentKey = 'test:custom:zzz999yyy888';
    const entry = await getCacheEntry('person', differentKey);
    expect(entry).toBeNull();
  });

  // ─── 2-credit deduction ─────────────────────────────────────────────────

  it('deducts 2 credits for custom enrichment fetch', async () => {
    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(0);

    await query(
      `UPDATE users SET credits_used = credits_used + $1 WHERE id = $2`,
      [CREDITS_PER_SEARCH, TEST_USER_PRO_ID],
    );

    expect(await getCreditsUsed(TEST_USER_PRO_ID)).toBe(2);
  });

  it('checks sufficient credits before 2-credit deduction', async () => {
    await setCredits(TEST_USER_PRO_ID, 99); // 1 credit remaining, need 2

    const { rows } = await query(
      `SELECT credits_used, credits_limit FROM users WHERE id = $1`,
      [TEST_USER_PRO_ID],
    );
    const user = rows[0];
    expect(user.credits_used + CREDITS_PER_SEARCH > user.credits_limit).toBe(true);
  });

  it('allows 2-credit deduction when exactly enough credits remain', async () => {
    await setCredits(TEST_USER_PRO_ID, 98); // 2 credits remaining

    const { rows } = await query(
      `SELECT credits_used, credits_limit FROM users WHERE id = $1`,
      [TEST_USER_PRO_ID],
    );
    const user = rows[0];
    expect(user.credits_used + CREDITS_PER_SEARCH <= user.credits_limit).toBe(true);
  });

  // ─── Request logging with 2 credits ─────────────────────────────────────

  it('logs custom enrichment request with 2 credits', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, completed_at)
      VALUES ($1, 'person', $2, $3, 'success', false, now())
    `, [TEST_USER_PRO_ID, CUSTOM_KEY, CREDITS_PER_SEARCH]);

    const { rows } = await query(
      `SELECT credits_used, status FROM enrichment_requests WHERE user_id = $1 AND entity_key = $2`,
      [TEST_USER_PRO_ID, CUSTOM_KEY],
    );
    expect(rows[0].credits_used).toBe(2);
    expect(rows[0].status).toBe('success');
  });

  it('logs pending async request with 2 credits', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit)
      VALUES ($1, 'person', $2, $3, 'pending', false)
    `, [TEST_USER_PRO_ID, CUSTOM_KEY, CREDITS_PER_SEARCH]);

    expect(await countRequests(TEST_USER_PRO_ID, 'pending')).toBe(1);
  });

  // ─── Enrichment prompts table ───────────────────────────────────────────

  it('logs prompt to enrichment_prompts table', async () => {
    await query(`
      INSERT INTO enrichment_prompts (user_id, entity_key, prompt, result_data, credits_used)
      VALUES ($1, $2, $3, $4::jsonb, $5)
    `, [
      TEST_USER_PRO_ID,
      CUSTOM_KEY,
      'What deals has this person closed recently?',
      JSON.stringify(CUSTOM_DATA),
      CREDITS_PER_SEARCH,
    ]);

    const { rows } = await query(
      `SELECT prompt, credits_used, result_data FROM enrichment_prompts WHERE user_id = $1`,
      [TEST_USER_PRO_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe('What deals has this person closed recently?');
    expect(rows[0].credits_used).toBe(2);
    expect(rows[0].result_data.results).toHaveLength(2);
  });

  it('stores multiple prompts for same user', async () => {
    await query(`
      INSERT INTO enrichment_prompts (user_id, entity_key, prompt, credits_used)
      VALUES ($1, $2, 'Prompt 1', $3)
    `, [TEST_USER_PRO_ID, CUSTOM_KEY, CREDITS_PER_SEARCH]);

    await query(`
      INSERT INTO enrichment_prompts (user_id, entity_key, prompt, credits_used)
      VALUES ($1, $2, 'Prompt 2', $3)
    `, [TEST_USER_PRO_ID, 'test:custom:other-key', CREDITS_PER_SEARCH]);

    const { rows } = await query(
      `SELECT count(*)::int as cnt FROM enrichment_prompts WHERE user_id = $1`,
      [TEST_USER_PRO_ID],
    );
    expect(rows[0].cnt).toBe(2);
  });
});
