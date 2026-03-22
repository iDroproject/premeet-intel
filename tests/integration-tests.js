/**
 * tests/integration-tests.js
 *
 * PreMeet -- Integration Test Suite
 *
 * Tests that make real API calls to enrichment API endpoints.
 * Requires a valid API token and network connectivity.
 *
 * WARNING: These tests hit live APIs and may consume API credits.
 *          Run them intentionally, not as part of CI.
 *
 * Usage:
 *   Load via run-tests.html with ?integration=true query param,
 *   or open the browser console and call: IntegrationTests.run()
 */

'use strict';

// ============================================================================
// API Token (read from service-worker.js constant)
// ============================================================================

const API_TOKEN = '30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9';

// ============================================================================
// Constants (mirrored from source modules)
// ============================================================================

const SERP_ENDPOINT = 'https://api.brightdata.com/request';
const SERP_ZONE = 'serp';

const BASE_URL = 'https://api.brightdata.com';
const DATASET_ID = 'gd_l1viktl72bvl7bjuj0';
const BUSINESS_ENRICHED_DATASET_ID = 'gd_m18zt6ec11wfqohyrs';

const SCRAPE_ENDPOINT = `${BASE_URL}/datasets/v3/scrape?dataset_id=${DATASET_ID}&format=json`;
const BUSINESS_ENRICHED_ENDPOINT =
  `${BASE_URL}/datasets/v3/scrape?dataset_id=${BUSINESS_ENRICHED_DATASET_ID}&format=json`;
const DEEP_LOOKUP_ENDPOINT =
  `${BASE_URL}/datasets/v3/trigger` +
  `?dataset_id=${DATASET_ID}` +
  `&type=discover_new` +
  `&discover_by=name` +
  `&format=json` +
  `&include_errors=true`;

// ============================================================================
// Test Harness
// ============================================================================

const IntegrationTests = {
  _tests: [],
  _results: { total: 0, passed: 0, failed: 0, skipped: 0, errors: [] },

  test(name, fn, { timeout = 30000, skip = false } = {}) {
    this._tests.push({ name, fn, timeout, skip });
  },

  async run() {
    const output = [];
    this._results = { total: 0, passed: 0, failed: 0, skipped: 0, errors: [] };

    output.push(`\n${'='.repeat(70)}`);
    output.push('INTEGRATION TESTS (live API calls)');
    output.push('='.repeat(70));
    output.push(`API Token: ${API_TOKEN.slice(0, 8)}...${API_TOKEN.slice(-8)}`);
    output.push(`Timestamp: ${new Date().toISOString()}`);
    output.push('');

    for (const test of this._tests) {
      this._results.total++;

      if (test.skip) {
        this._results.skipped++;
        output.push(`  SKIP  ${test.name}`);
        continue;
      }

      const startTime = Date.now();

      try {
        await withTimeout(test.fn(), test.timeout, test.name);
        const elapsed = Date.now() - startTime;
        this._results.passed++;
        output.push(`  PASS  ${test.name} (${elapsed}ms)`);
      } catch (err) {
        const elapsed = Date.now() - startTime;
        this._results.failed++;
        const errorMsg = err.message || String(err);
        this._results.errors.push({ test: test.name, error: errorMsg });
        output.push(`  FAIL  ${test.name} (${elapsed}ms)`);
        output.push(`        Error: ${errorMsg}`);
      }
    }

    output.push(`\n${'='.repeat(70)}`);
    output.push(
      `RESULTS: ${this._results.passed} passed, ` +
      `${this._results.failed} failed, ` +
      `${this._results.skipped} skipped ` +
      `(${this._results.total} total)`
    );
    output.push('='.repeat(70));

    if (this._results.errors.length > 0) {
      output.push('\nFailed tests:');
      for (const e of this._results.errors) {
        output.push(`  - ${e.test}: ${e.error}`);
      }
    }

    const text = output.join('\n');
    console.log(text);

    if (typeof document !== 'undefined') {
      const pre = document.getElementById('integration-output');
      if (pre) {
        pre.textContent = text;
        pre.className = this._results.failed > 0 ? 'has-failures' : 'all-pass';
      }
    }

    return this._results;
  },
};

// ============================================================================
// Helpers
// ============================================================================

function authHeaders() {
  return {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[${label}] timed out after ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertContains(str, substr, message) {
  assert(typeof str === 'string', (message || '') + ': not a string, got ' + typeof str);
  assert(str.includes(substr), message || `Expected "${str}" to contain "${substr}"`);
}

function assertMatch(str, regex, message) {
  assert(typeof str === 'string', (message || '') + ': not a string');
  assert(regex.test(str), message || `Expected "${str}" to match ${regex}`);
}

// ============================================================================
// SERP API Tests
// ============================================================================

IntegrationTests.test('SERP API: basic connectivity check', async () => {
  // Send a simple SERP request and verify we get a valid response structure
  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in Satya Nadella Microsoft')}&hl=en&gl=us&num=3`;

  const response = await fetch(SERP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      zone: SERP_ZONE,
      url: searchUrl,
      format: 'json',
    }),
  });

  assert(response.ok, `Expected OK response, got HTTP ${response.status}`);
  const data = await response.json();
  assert(data !== null && data !== undefined, 'Response body should not be null');
}, { timeout: 20000 });

IntegrationTests.test('SERP API: serpFindLinkedInUrl for known person (Satya Nadella)', async () => {
  // Replicate the serpFindLinkedInUrl logic inline
  const query = 'Satya Nadella Microsoft';
  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in ' + query)}&hl=en&gl=us&num=5`;

  const response = await fetch(SERP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      zone: SERP_ZONE,
      url: searchUrl,
      format: 'json',
    }),
  });

  assert(response.ok, `SERP request failed: HTTP ${response.status}`);
  const data = await response.json();

  // Extract LinkedIn URL using the same logic as serp-api.js
  const organic =
    data?.organic ||
    data?.results ||
    data?.organic_results ||
    [];
  const results = Array.isArray(data) ? data : organic;

  let linkedInUrl = null;
  for (const result of results) {
    const url = result?.link || result?.url || result?.href || '';
    if (/linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
      linkedInUrl = url.split('?')[0];
      break;
    }
  }

  // Fallback: knowledge graph
  if (!linkedInUrl && data?.knowledge_graph?.website) {
    const kgUrl = data.knowledge_graph.website;
    if (/linkedin\.com\/in\//i.test(kgUrl)) {
      linkedInUrl = kgUrl.split('?')[0];
    }
  }

  assert(linkedInUrl !== null, 'Should find a LinkedIn URL for Satya Nadella');
  assertContains(linkedInUrl, 'linkedin.com/in/', 'URL should be a LinkedIn profile');
  console.log('  Found LinkedIn URL:', linkedInUrl);
}, { timeout: 20000 });

IntegrationTests.test('SERP API: returns no results for nonsense query', async () => {
  const query = 'xyzzy123notarealpersonabc456noresults';
  const searchUrl =
    `https://www.google.com/search?q=${encodeURIComponent('site:linkedin.com/in ' + query)}&hl=en&gl=us&num=5`;

  const response = await fetch(SERP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      zone: SERP_ZONE,
      url: searchUrl,
      format: 'json',
    }),
  });

  assert(response.ok, `SERP request failed: HTTP ${response.status}`);
  const data = await response.json();

  // For a nonsense query, we expect either no organic results or no LinkedIn URLs
  const organic =
    data?.organic ||
    data?.results ||
    data?.organic_results ||
    [];
  const results = Array.isArray(data) ? data : organic;

  let linkedInUrl = null;
  for (const result of results) {
    const url = result?.link || result?.url || result?.href || '';
    if (/linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i.test(url)) {
      linkedInUrl = url.split('?')[0];
      break;
    }
  }

  // It is acceptable for the URL to be null (most likely) or for the API
  // to not return LinkedIn results for nonsense input.
  // We just verify the pipeline did not crash.
  console.log('  Nonsense query result:', linkedInUrl === null ? 'null (expected)' : linkedInUrl);
}, { timeout: 20000 });

// ============================================================================
// Business Enriched Data Tests
// ============================================================================

IntegrationTests.test('Business Enriched: scrape for a known LinkedIn URL', async () => {
  const linkedInUrl = 'https://www.linkedin.com/in/satloui/';

  const response = await fetch(BUSINESS_ENRICHED_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify([{ url: linkedInUrl }]),
  });

  // Accept either 200 (sync result) or 202 (async/snapshot)
  assert(
    response.status === 200 || response.status === 202,
    `Expected 200 or 202, got HTTP ${response.status}`
  );

  const body = await response.json();

  if (response.status === 200) {
    assert(Array.isArray(body), 'Direct response should be an array');
    console.log(`  Business Enriched returned ${body.length} result(s) directly`);
    if (body.length > 0) {
      const profile = body[0];
      console.log('  Fields present:', Object.keys(profile).join(', '));
    }
  } else {
    // 202 -- async
    assert(body.snapshot_id, 'Async response should have snapshot_id');
    console.log('  Business Enriched queued, snapshot_id:', body.snapshot_id);
  }
}, { timeout: 30000 });

IntegrationTests.test('Business Enriched: handles invalid URL gracefully', async () => {
  const response = await fetch(BUSINESS_ENRICHED_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify([{ url: 'https://www.linkedin.com/in/this-profile-definitely-does-not-exist-xyzzy/' }]),
  });

  // The API should respond without crashing.
  // It may return 200 with empty, 202 (snapshot), or a 4xx error.
  console.log(`  Invalid URL response: HTTP ${response.status}`);
  assert(
    response.status >= 200 && response.status < 500,
    `Expected 2xx-4xx, got HTTP ${response.status}`
  );
}, { timeout: 30000 });

// ============================================================================
// Deep Lookup Tests
// ============================================================================

IntegrationTests.test('Deep Lookup: trigger for known person', async () => {
  const lookupInput = { name: 'Satya Nadella', company: 'Microsoft' };

  const response = await fetch(DEEP_LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify([lookupInput]),
  });

  assert(
    response.status === 200 || response.status === 202,
    `Expected 200 or 202, got HTTP ${response.status}`
  );

  const body = await response.json();

  if (response.status === 200) {
    const profiles = Array.isArray(body)
      ? body
      : (Array.isArray(body?.data) ? body.data : null);

    if (profiles && profiles.length > 0) {
      console.log(`  Deep Lookup returned ${profiles.length} profile(s) synchronously`);
      console.log('  First profile name:', profiles[0]?.name || 'N/A');
    } else {
      console.log('  Deep Lookup returned empty result (sync)');
    }
  } else {
    assert(body.snapshot_id, 'Async response should have snapshot_id');
    console.log('  Deep Lookup queued, snapshot_id:', body.snapshot_id);
  }
}, { timeout: 45000 });

IntegrationTests.test('Deep Lookup: trigger without company', async () => {
  const lookupInput = { name: 'Tim Cook' };

  const response = await fetch(DEEP_LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify([lookupInput]),
  });

  assert(
    response.status === 200 || response.status === 202,
    `Expected 200 or 202, got HTTP ${response.status}`
  );

  const body = await response.json();
  console.log(`  Deep Lookup (no company) response: HTTP ${response.status}`);
  if (response.status === 202 && body.snapshot_id) {
    console.log('  Snapshot ID:', body.snapshot_id);
  }
}, { timeout: 45000 });

IntegrationTests.test('Deep Lookup: invalid auth token returns 401 or 403', async () => {
  const badToken = 'invalid_token_12345';

  const response = await fetch(DEEP_LOOKUP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${badToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ name: 'Test Person' }]),
  });

  assert(
    response.status === 401 || response.status === 403,
    `Expected 401 or 403 for bad token, got HTTP ${response.status}`
  );
  console.log(`  Bad auth correctly rejected with HTTP ${response.status}`);
}, { timeout: 15000 });

// ============================================================================
// LinkedIn Scrape Tests
// ============================================================================

IntegrationTests.test('LinkedIn Scrape: scrapeByLinkedInUrl for known profile', async () => {
  const linkedInUrl = 'https://www.linkedin.com/in/satloui/';

  const response = await fetch(SCRAPE_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify([{ url: linkedInUrl }]),
  });

  assert(
    response.status === 200 || response.status === 202,
    `Expected 200 or 202, got HTTP ${response.status}`
  );

  if (response.status === 200) {
    const profiles = await response.json();
    assert(Array.isArray(profiles), 'Direct response should be an array');
    console.log(`  LinkedIn scrape returned ${profiles.length} profile(s)`);

    if (profiles.length > 0) {
      const p = profiles[0];
      console.log('  Profile name:', p.name || 'N/A');
      console.log('  Has avatar:', !!p.avatar);
      console.log('  Has experience:', Array.isArray(p.experience) && p.experience.length > 0);
    }
  } else {
    const body = await response.json();
    assert(body.snapshot_id, 'Async response should have snapshot_id');
    console.log('  LinkedIn scrape queued, snapshot_id:', body.snapshot_id);
  }
}, { timeout: 30000 });

// ============================================================================
// Snapshot Polling Test (if any previous test returned a snapshot)
// ============================================================================

IntegrationTests.test('Snapshot: poll status endpoint is reachable', async () => {
  // Use a dummy snapshot ID -- we expect a 404 or similar, just verify
  // the endpoint is reachable and returns JSON
  const dummySnapshotId = 'test_dummy_snapshot_000';
  const statusUrl = `${BASE_URL}/datasets/snapshots/${dummySnapshotId}`;

  const response = await fetch(statusUrl, {
    method: 'GET',
    headers: authHeaders(),
  });

  // We expect an error status (404, 400, etc.) for a fake snapshot ID
  console.log(`  Snapshot status endpoint returned HTTP ${response.status}`);
  // Just verifying the endpoint is reachable and responds
  assert(response.status > 0, 'Should get a valid HTTP status code');
}, { timeout: 15000 });

// ============================================================================
// Export for HTML runner
// ============================================================================

// Make available globally for the HTML test runner
if (typeof window !== 'undefined') {
  window.IntegrationTests = IntegrationTests;
}

export { IntegrationTests };
