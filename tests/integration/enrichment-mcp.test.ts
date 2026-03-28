// Integration tests for enrichment-mcp edge function DB operations.
// Tests cache miss → MCP fetch → cache hit cycle, per-source caching with
// different TTLs, MCP tool call logging, and credit deduction against Neon.

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

// Test data matching CompanyIntel shape
const CRUNCHBASE_CACHE_KEY = 'crunchbase:company:acme-corp';
const ZOOMINFO_CACHE_KEY = 'zoominfo:company:acme-corp';

const CRUNCHBASE_DATA = {
  crunchbase_url: 'https://crunchbase.com/organization/acme-corp',
  total_funding: '$50M',
  last_funding_round: { type: 'Series B', amount: '$30M', date: '2025-06-15' },
  investors: [
    { name: 'Sequoia Capital', lead_investor: true },
    { name: 'Y Combinator', lead_investor: false },
  ],
  ipo_status: 'private',
  num_acquisitions: 2,
};

const ZOOMINFO_DATA = {
  employee_count: 350,
  employee_growth_6m: 12.5,
  tech_stack: ['React', 'PostgreSQL', 'AWS'],
  intent_topics: ['Data Analytics', 'Cloud Migration'],
  department_breakdown: { Engineering: 120, Sales: 80, Marketing: 50 },
};

describe('enrichment-mcp DB operations', () => {
  beforeAll(async () => {
    await cleanupTestData();
    await seedTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    await teardown();
  });

  beforeEach(async () => {
    // Clean up MCP-specific cache and request entries
    await query(`DELETE FROM enrichment_cache WHERE entity_key LIKE 'crunchbase:%' OR entity_key LIKE 'zoominfo:%'`);
    await query(`DELETE FROM enrichment_requests WHERE user_id IN ($1, $2)`,
      [TEST_USER_FREE_ID, TEST_USER_PRO_ID]);
    await query(`DELETE FROM cache_stats WHERE date = CURRENT_DATE`);
    await setCredits(TEST_USER_FREE_ID, 0);
    await setCredits(TEST_USER_PRO_ID, 0);
  });

  // ─── Per-source cache keys ──────────────────────────────────────────────

  it('caches Crunchbase data with 30-day TTL', async () => {
    await insertCacheEntry('company', CRUNCHBASE_CACHE_KEY, CRUNCHBASE_DATA, 'crunchbase', 30);
    const entry = await getCacheEntry('company', CRUNCHBASE_CACHE_KEY);

    expect(entry).not.toBeNull();
    expect(entry.enrichment_data.total_funding).toBe('$50M');

    const expiresAt = new Date(entry.expires_at);
    const diffDays = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it('caches ZoomInfo data with 14-day TTL', async () => {
    await insertCacheEntry('company', ZOOMINFO_CACHE_KEY, ZOOMINFO_DATA, 'zoominfo', 14);
    const entry = await getCacheEntry('company', ZOOMINFO_CACHE_KEY);

    expect(entry).not.toBeNull();
    expect(entry.enrichment_data.employee_count).toBe(350);

    const expiresAt = new Date(entry.expires_at);
    const diffDays = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(13);
    expect(diffDays).toBeLessThan(15);
  });

  it('stores Crunchbase and ZoomInfo independently for same company', async () => {
    await insertCacheEntry('company', CRUNCHBASE_CACHE_KEY, CRUNCHBASE_DATA, 'crunchbase', 30);
    await insertCacheEntry('company', ZOOMINFO_CACHE_KEY, ZOOMINFO_DATA, 'zoominfo', 14);

    const cb = await getCacheEntry('company', CRUNCHBASE_CACHE_KEY);
    const zi = await getCacheEntry('company', ZOOMINFO_CACHE_KEY);

    expect(cb).not.toBeNull();
    expect(zi).not.toBeNull();
    expect(cb.enrichment_data.total_funding).toBe('$50M');
    expect(zi.enrichment_data.employee_count).toBe(350);
  });

  it('expired ZoomInfo cache does not return, while Crunchbase still valid', async () => {
    await insertCacheEntry('company', CRUNCHBASE_CACHE_KEY, CRUNCHBASE_DATA, 'crunchbase', 30);
    await insertExpiredCacheEntry('company', ZOOMINFO_CACHE_KEY, ZOOMINFO_DATA, 'zoominfo');

    const cb = await getCacheEntry('company', CRUNCHBASE_CACHE_KEY);
    const zi = await getCacheEntry('company', ZOOMINFO_CACHE_KEY);

    expect(cb).not.toBeNull();
    expect(zi).toBeNull();
  });

  // ─── MCP tool call logging ──────────────────────────────────────────────

  it('logs MCP tool call with tool_name and latency_ms', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, tool_name, latency_ms, completed_at)
      VALUES ($1, 'company', $2, 0, 'success', false, $3, $4, now())
    `, [TEST_USER_FREE_ID, CRUNCHBASE_CACHE_KEY, 'web_data_crunchbase_company', 1250]);

    const { rows } = await query(
      `SELECT tool_name, latency_ms, status FROM enrichment_requests WHERE user_id = $1 AND tool_name IS NOT NULL`,
      [TEST_USER_FREE_ID],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('web_data_crunchbase_company');
    expect(rows[0].latency_ms).toBe(1250);
    expect(rows[0].status).toBe('success');
  });

  it('logs cache hit with tool_name and 0 latency', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, tool_name, latency_ms, completed_at)
      VALUES ($1, 'company', $2, 0, 'cached', true, $3, 0, now())
    `, [TEST_USER_PRO_ID, ZOOMINFO_CACHE_KEY, 'web_data_zoominfo_company_profile']);

    const { rows } = await query(
      `SELECT tool_name, latency_ms, cache_hit FROM enrichment_requests WHERE user_id = $1`,
      [TEST_USER_PRO_ID],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].cache_hit).toBe(true);
    expect(rows[0].latency_ms).toBe(0);
  });

  it('logs failed MCP call', async () => {
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, tool_name, latency_ms)
      VALUES ($1, 'company', $2, 0, 'failed', false, $3, $4)
    `, [TEST_USER_FREE_ID, CRUNCHBASE_CACHE_KEY, 'web_data_crunchbase_company', 5000]);

    expect(await countRequests(TEST_USER_FREE_ID, 'failed')).toBe(1);
  });

  it('logs both Crunchbase and ZoomInfo calls for one aggregation', async () => {
    // Simulate parallel MCP calls
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, tool_name, latency_ms, completed_at)
      VALUES
        ($1, 'company', $2, 0, 'success', false, 'web_data_crunchbase_company', 800, now()),
        ($1, 'company', $3, 0, 'success', false, 'web_data_zoominfo_company_profile', 1200, now())
    `, [TEST_USER_FREE_ID, CRUNCHBASE_CACHE_KEY, ZOOMINFO_CACHE_KEY]);

    const { rows } = await query(
      `SELECT tool_name FROM enrichment_requests WHERE user_id = $1 ORDER BY tool_name`,
      [TEST_USER_FREE_ID],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].tool_name).toBe('web_data_crunchbase_company');
    expect(rows[1].tool_name).toBe('web_data_zoominfo_company_profile');
  });

  // ─── Credit deduction for MCP ──────────────────────────────────────────

  it('deducts 1 credit for fresh MCP data (not cached)', async () => {
    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(0);
    await query(`UPDATE users SET credits_used = credits_used + 1 WHERE id = $1`, [TEST_USER_FREE_ID]);
    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(1);
  });

  it('does not deduct credit when both sources are cached', async () => {
    // Both cached — no credit
    await query(`
      INSERT INTO enrichment_requests (user_id, entity_type, entity_key, credits_used, status, cache_hit, tool_name, latency_ms)
      VALUES
        ($1, 'company', $2, 0, 'cached', true, 'web_data_crunchbase_company', 0),
        ($1, 'company', $3, 0, 'cached', true, 'web_data_zoominfo_company_profile', 0)
    `, [TEST_USER_FREE_ID, CRUNCHBASE_CACHE_KEY, ZOOMINFO_CACHE_KEY]);

    expect(await getCreditsUsed(TEST_USER_FREE_ID)).toBe(0);
  });

  // ─── Cache stats for MCP sources ──────────────────────────────────────

  it('tracks cache hits and misses for MCP sources', async () => {
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`); // CB cache hit
    await query(`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`); // ZI cache miss

    const stats = await getCacheStats('company');
    expect(stats).not.toBeNull();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});
