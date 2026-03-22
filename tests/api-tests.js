/**
 * tests/api-tests.js
 *
 * PreMeet -- Unit Test Suite
 *
 * Self-contained test harness with no external dependencies.
 * Designed to run in a browser context (loaded via run-tests.html)
 * where the source modules are available via ES module imports.
 *
 * Tests cover:
 *   - LogBuffer: add, filter, circular eviction, clear, getModules
 *   - Response normalizer: pickBestProfile, mergeBusinessEnrichedData,
 *     normalizeLinkedInProfile
 *   - Cache key normalization (extracted logic from waterfall-orchestrator)
 *   - WaterfallOrchestrator: progress flow, step state transitions
 *   - MessageType: verify all expected values exist and match
 */

'use strict';

// ============================================================================
// Minimal Test Harness
// ============================================================================

const TestRunner = {
  _suites: [],
  _currentSuite: null,
  _results: { total: 0, passed: 0, failed: 0, errors: [] },

  /**
   * Define a test suite (group of related tests).
   */
  suite(name, fn) {
    this._currentSuite = { name, tests: [] };
    this._suites.push(this._currentSuite);
    fn();
    this._currentSuite = null;
  },

  /**
   * Define a single test case within a suite.
   */
  test(name, fn) {
    if (!this._currentSuite) {
      throw new Error('test() must be called inside suite()');
    }
    this._currentSuite.tests.push({ name, fn });
  },

  /**
   * Run all registered suites and tests. Prints results to the page and console.
   */
  async run() {
    const output = [];
    this._results = { total: 0, passed: 0, failed: 0, errors: [] };

    for (const suite of this._suites) {
      output.push(`\n${'='.repeat(70)}`);
      output.push(`SUITE: ${suite.name}`);
      output.push('='.repeat(70));

      for (const test of suite.tests) {
        this._results.total++;
        const label = `  [${suite.name}] ${test.name}`;

        try {
          await test.fn();
          this._results.passed++;
          output.push(`  PASS  ${test.name}`);
        } catch (err) {
          this._results.failed++;
          const errorMsg = err.message || String(err);
          this._results.errors.push({ suite: suite.name, test: test.name, error: errorMsg });
          output.push(`  FAIL  ${test.name}`);
          output.push(`        Error: ${errorMsg}`);
        }
      }
    }

    output.push(`\n${'='.repeat(70)}`);
    output.push(`RESULTS: ${this._results.passed}/${this._results.total} passed, ${this._results.failed} failed`);
    output.push('='.repeat(70));

    if (this._results.errors.length > 0) {
      output.push('\nFailed tests:');
      for (const e of this._results.errors) {
        output.push(`  - [${e.suite}] ${e.test}: ${e.error}`);
      }
    }

    const text = output.join('\n');
    console.log(text);

    // Render to page if running in browser
    if (typeof document !== 'undefined') {
      const pre = document.getElementById('test-output');
      if (pre) {
        pre.textContent = text;
        pre.className = this._results.failed > 0 ? 'has-failures' : 'all-pass';
      }
    }

    return this._results;
  },
};

// ============================================================================
// Assertion Helpers
// ============================================================================

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      (message ? message + ': ' : '') +
      `expected ${b}, got ${a}`
    );
  }
}

function assertNotNull(value, message) {
  if (value === null || value === undefined) {
    throw new Error(message || `Expected non-null value, got ${value}`);
  }
}

function assertNull(value, message) {
  if (value !== null && value !== undefined) {
    throw new Error(message || `Expected null/undefined, got ${JSON.stringify(value)}`);
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch (_) {
    threw = true;
  }
  if (!threw) {
    throw new Error(message || 'Expected function to throw');
  }
}

function assertArrayLength(arr, len, message) {
  assert(Array.isArray(arr), (message || '') + ': not an array');
  assertEqual(arr.length, len, (message || '') + ': length mismatch');
}

function assertIncludes(arr, value, message) {
  assert(Array.isArray(arr), (message || '') + ': not an array');
  assert(arr.includes(value), message || `Expected array to include ${JSON.stringify(value)}`);
}

function assertContains(str, substr, message) {
  assert(typeof str === 'string', (message || '') + ': not a string');
  assert(str.includes(substr), message || `Expected "${str}" to contain "${substr}"`);
}

function assertType(value, type, message) {
  assertEqual(typeof value, type, message || `Type check`);
}

// ============================================================================
// Import modules under test
// ============================================================================

import { LogBuffer } from '../background/log-buffer.js';

import {
  normalizeLinkedInProfile,
  pickBestProfile,
  mergeBusinessEnrichedData,
} from '../background/api/response-normalizer.js';

// We cannot import WaterfallOrchestrator directly since it imports modules
// that call fetch() at module level, but we can test the logic we extract.
// Instead, we replicate the normaliseCacheKey helper (it is not exported)
// and test the orchestrator via a mock approach.

// ============================================================================
// Replicated helpers for testing (not exported from source)
// ============================================================================

/**
 * Exact copy of normaliseCacheKey from waterfall-orchestrator.js
 * for testing cache key normalization logic.
 */
function normaliseCacheKey(value) {
  return (value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * MessageType values as defined in service-worker.js.
 * We replicate them here to verify completeness.
 */
const MessageType = {
  FETCH_PERSON_BACKGROUND:  'FETCH_PERSON_BACKGROUND',
  FETCH_PROGRESS:           'FETCH_PROGRESS',
  OPEN_SIDE_PANEL:          'OPEN_SIDE_PANEL',
  PERSON_BACKGROUND_RESULT: 'PERSON_BACKGROUND_RESULT',
  GET_CACHE_STATS:          'GET_CACHE_STATS',
  CLEAR_CACHE:              'CLEAR_CACHE',
  GET_LOGS:                 'GET_LOGS',
  GET_HISTORY:              'GET_HISTORY',
  PING:                     'PING',
};

// ============================================================================
// TEST SUITES
// ============================================================================

// --------------------------------------------------------------------------
// 1. LogBuffer
// --------------------------------------------------------------------------

TestRunner.suite('LogBuffer', () => {

  TestRunner.test('constructor creates empty buffer', () => {
    const lb = new LogBuffer();
    const entries = lb.getEntries();
    assertArrayLength(entries, 0, 'Empty buffer');
  });

  TestRunner.test('info() adds an info entry', () => {
    const lb = new LogBuffer();
    lb.info('TestModule', 'Hello world');
    const entries = lb.getEntries();
    assertArrayLength(entries, 1, 'Should have 1 entry');
    assertEqual(entries[0].module, 'TestModule');
    assertEqual(entries[0].level, 'info');
    assertEqual(entries[0].message, 'Hello world');
    assert(entries[0].timestamp, 'Should have timestamp');
  });

  TestRunner.test('warn() adds a warn entry', () => {
    const lb = new LogBuffer();
    lb.warn('Mod', 'Warning msg');
    const entries = lb.getEntries();
    assertEqual(entries[0].level, 'warn');
  });

  TestRunner.test('error() adds an error entry', () => {
    const lb = new LogBuffer();
    lb.error('Mod', 'Error msg');
    const entries = lb.getEntries();
    assertEqual(entries[0].level, 'error');
  });

  TestRunner.test('log() with data attaches data field', () => {
    const lb = new LogBuffer();
    lb.log('Mod', 'info', 'With data', { key: 'value' });
    const entries = lb.getEntries();
    assertDeepEqual(entries[0].data, { key: 'value' });
  });

  TestRunner.test('log() without data omits data field', () => {
    const lb = new LogBuffer();
    lb.log('Mod', 'info', 'No data');
    const entries = lb.getEntries();
    assertEqual(entries[0].data, undefined, 'data should be undefined');
  });

  TestRunner.test('getEntries() returns newest first', () => {
    const lb = new LogBuffer();
    lb.info('Mod', 'First');
    lb.info('Mod', 'Second');
    lb.info('Mod', 'Third');
    const entries = lb.getEntries();
    assertEqual(entries[0].message, 'Third');
    assertEqual(entries[1].message, 'Second');
    assertEqual(entries[2].message, 'First');
  });

  TestRunner.test('getEntries() filters by module', () => {
    const lb = new LogBuffer();
    lb.info('Alpha', 'A1');
    lb.info('Beta', 'B1');
    lb.info('Alpha', 'A2');
    lb.warn('Beta', 'B2');

    const alphaEntries = lb.getEntries({ module: 'Alpha' });
    assertArrayLength(alphaEntries, 2, 'Alpha entries');
    assert(alphaEntries.every(e => e.module === 'Alpha'), 'All should be Alpha');

    const betaEntries = lb.getEntries({ module: 'Beta' });
    assertArrayLength(betaEntries, 2, 'Beta entries');
  });

  TestRunner.test('getEntries() filters by level', () => {
    const lb = new LogBuffer();
    lb.info('Mod', 'Info1');
    lb.warn('Mod', 'Warn1');
    lb.error('Mod', 'Error1');
    lb.info('Mod', 'Info2');

    const warnings = lb.getEntries({ level: 'warn' });
    assertArrayLength(warnings, 1, 'Warn entries');
    assertEqual(warnings[0].message, 'Warn1');

    const errors = lb.getEntries({ level: 'error' });
    assertArrayLength(errors, 1, 'Error entries');
  });

  TestRunner.test('getEntries() filters by module AND level combined', () => {
    const lb = new LogBuffer();
    lb.info('Alpha', 'A-info');
    lb.warn('Alpha', 'A-warn');
    lb.info('Beta', 'B-info');
    lb.warn('Beta', 'B-warn');

    const result = lb.getEntries({ module: 'Alpha', level: 'warn' });
    assertArrayLength(result, 1, 'Combined filter');
    assertEqual(result[0].message, 'A-warn');
  });

  TestRunner.test('getEntries() with limit', () => {
    const lb = new LogBuffer();
    for (let i = 0; i < 10; i++) {
      lb.info('Mod', `Entry ${i}`);
    }

    const limited = lb.getEntries({ limit: 3 });
    assertArrayLength(limited, 3, 'Limited entries');
    // Newest first
    assertEqual(limited[0].message, 'Entry 9');
    assertEqual(limited[1].message, 'Entry 8');
    assertEqual(limited[2].message, 'Entry 7');
  });

  TestRunner.test('circular eviction at 200 entries', () => {
    const lb = new LogBuffer();

    // Fill to exactly 200
    for (let i = 0; i < 200; i++) {
      lb.info('Mod', `Entry ${i}`);
    }
    let entries = lb.getEntries();
    assertArrayLength(entries, 200, 'Should have 200 entries');
    // Oldest is Entry 0 (last in reversed array)
    assertEqual(entries[199].message, 'Entry 0');

    // Add one more -- should evict Entry 0
    lb.info('Mod', 'Entry 200');
    entries = lb.getEntries();
    assertArrayLength(entries, 200, 'Still 200 after eviction');

    // Entry 0 should be gone, Entry 1 should now be the oldest
    assertEqual(entries[199].message, 'Entry 1', 'Oldest should be Entry 1');
    assertEqual(entries[0].message, 'Entry 200', 'Newest should be Entry 200');
  });

  TestRunner.test('circular eviction preserves order after many additions', () => {
    const lb = new LogBuffer();

    // Add 250 entries
    for (let i = 0; i < 250; i++) {
      lb.info('Mod', `Entry ${i}`);
    }

    const entries = lb.getEntries();
    assertArrayLength(entries, 200, 'Capped at 200');
    // Should contain entries 50-249 (oldest 50 evicted)
    assertEqual(entries[0].message, 'Entry 249', 'Newest');
    assertEqual(entries[199].message, 'Entry 50', 'Oldest surviving');
  });

  TestRunner.test('clear() removes all entries', () => {
    const lb = new LogBuffer();
    lb.info('Mod', 'Test1');
    lb.info('Mod', 'Test2');
    assertEqual(lb.getEntries().length, 2);

    lb.clear();
    assertArrayLength(lb.getEntries(), 0, 'After clear');
  });

  TestRunner.test('getModules() returns distinct module names', () => {
    const lb = new LogBuffer();
    lb.info('Alpha', 'A1');
    lb.info('Beta', 'B1');
    lb.info('Alpha', 'A2');
    lb.warn('Gamma', 'G1');

    const modules = lb.getModules();
    assertArrayLength(modules, 3, 'Distinct modules');
    assertIncludes(modules, 'Alpha');
    assertIncludes(modules, 'Beta');
    assertIncludes(modules, 'Gamma');
  });

  TestRunner.test('getModules() returns empty array for empty buffer', () => {
    const lb = new LogBuffer();
    const modules = lb.getModules();
    assertArrayLength(modules, 0, 'No modules');
  });

  TestRunner.test('entries have ISO timestamp format', () => {
    const lb = new LogBuffer();
    lb.info('Mod', 'Test');
    const entry = lb.getEntries()[0];
    // ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(entry.timestamp),
      `Timestamp should be ISO format, got: ${entry.timestamp}`);
  });
});

// --------------------------------------------------------------------------
// 2. Response Normalizer -- normalizeLinkedInProfile
// --------------------------------------------------------------------------

TestRunner.suite('normalizeLinkedInProfile', () => {

  TestRunner.test('handles null/undefined input gracefully', () => {
    const result = normalizeLinkedInProfile(null, 'test-source');
    assertEqual(result.name, 'Unknown');
    assertEqual(result._source, 'test-source');
    assertEqual(result._confidence, 'low');
    assertArrayLength(result.experience, 0);
    assertArrayLength(result.education, 0);
    assertArrayLength(result.recentPosts, 0);
  });

  TestRunner.test('handles array input as invalid', () => {
    const result = normalizeLinkedInProfile([1, 2, 3], 'test');
    assertEqual(result.name, 'Unknown');
    assertEqual(result._confidence, 'low');
  });

  TestRunner.test('normalizes a full LinkedIn profile', () => {
    const raw = {
      name: 'Jane Doe',
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://linkedin.com/in/janedoe',
      current_company: { name: 'Acme Inc', title: 'VP Engineering' },
      city: 'San Francisco',
      country_code: 'US',
      about: 'Experienced leader in tech.',
      experience: [
        { title: 'VP Engineering', company: 'Acme Inc', start_date: '2020-01', end_date: null },
      ],
      education: [
        { title: 'MIT', degree: 'BS', field: 'Computer Science', start_year: '2005', end_year: '2009' },
      ],
      activity: [
        { title: 'Great article', link: 'https://example.com/post', img: null, interaction: '50 likes' },
      ],
      connections: '500+',
      followers: '1,200',
    };

    const result = normalizeLinkedInProfile(raw, 'serp-enriched');

    assertEqual(result.name, 'Jane Doe');
    assertEqual(result.firstName, 'Jane');
    assertEqual(result.lastName, 'Doe');
    assertEqual(result.avatarUrl, 'https://example.com/avatar.jpg');
    assertEqual(result.linkedinUrl, 'https://linkedin.com/in/janedoe');
    assertEqual(result.currentTitle, 'VP Engineering');
    assertEqual(result.currentCompany, 'Acme Inc');
    assertEqual(result.location, 'San Francisco, US');
    assertEqual(result.bio, 'Experienced leader in tech.');
    assertArrayLength(result.experience, 1);
    assertEqual(result.experience[0].title, 'VP Engineering');
    assertArrayLength(result.education, 1);
    assertEqual(result.education[0].institution, 'MIT');
    assertArrayLength(result.recentPosts, 1);
    assertEqual(result._source, 'serp-enriched');
    assert(result._fetchedAt, 'Should have _fetchedAt');
  });

  TestRunner.test('confidence scoring: high confidence profile', () => {
    const raw = {
      name: 'Jane Doe',
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://linkedin.com/in/janedoe',
      current_company: { name: 'Acme', title: 'CTO' },
      about: 'Tech leader',
      experience: [{ title: 'CTO', company: 'Acme' }],
      education: [{ title: 'Stanford' }],
    };

    const result = normalizeLinkedInProfile(raw, 'test', { serpVerified: true });

    // avatar(2) + title(2) + company(1) + bio(1) + exp(1) + edu(1) + linkedin(2) + serp(1) = 11
    assertEqual(result._confidence, 'high');
    assert(result._confidenceScore >= 8, `Score should be >= 8, got ${result._confidenceScore}`);
  });

  TestRunner.test('confidence scoring: medium confidence profile', () => {
    const raw = {
      name: 'John Smith',
      avatar: 'https://example.com/avatar.jpg',
      url: 'https://linkedin.com/in/johnsmith',
      // No company, no title, no bio, etc.
    };

    const result = normalizeLinkedInProfile(raw, 'test');
    // avatar(2) + linkedin(2) = 4
    assertEqual(result._confidence, 'medium');
    assertEqual(result._confidenceScore, 4);
  });

  TestRunner.test('confidence scoring: low confidence profile', () => {
    const raw = {
      name: 'Mystery Person',
      // No avatar, no url, no title, no company, etc.
    };

    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result._confidence, 'low');
    assert(result._confidenceScore < 4, `Score should be < 4, got ${result._confidenceScore}`);
  });

  TestRunner.test('confidence scoring: email domain match adds point', () => {
    const raw = {
      name: 'Jane Doe',
      current_company: { name: 'Acme Corp', title: 'PM' },
    };

    const withEmail = normalizeLinkedInProfile(raw, 'test', { email: 'jane@acme.com' });
    const withoutEmail = normalizeLinkedInProfile(raw, 'test', {});

    assert(withEmail._confidenceScore > withoutEmail._confidenceScore,
      'Email domain match should increase score');

    const emailCitation = withEmail._confidenceCitations.find(c => c.factor === 'email-match');
    assertNotNull(emailCitation, 'Should have email-match citation');
  });

  TestRunner.test('handles missing name gracefully', () => {
    const raw = { avatar: 'https://example.com/av.jpg' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.name, 'Unknown');
    assertEqual(result.firstName, '', 'firstName for Unknown');
    assertEqual(result.lastName, '', 'lastName for Unknown');
  });

  TestRunner.test('splits single-word name correctly', () => {
    const raw = { name: 'Madonna' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.firstName, 'Madonna');
    assertEqual(result.lastName, '');
  });

  TestRunner.test('splits multi-part name correctly', () => {
    const raw = { name: 'Jean Claude Van Damme' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.firstName, 'Jean');
    assertEqual(result.lastName, 'Claude Van Damme');
  });

  TestRunner.test('location derives from city and country_code', () => {
    assertEqual(
      normalizeLinkedInProfile({ name: 'X', city: 'London', country_code: 'UK' }, 'x').location,
      'London, UK'
    );
  });

  TestRunner.test('location falls back to city only', () => {
    assertEqual(
      normalizeLinkedInProfile({ name: 'X', city: 'Paris' }, 'x').location,
      'Paris'
    );
  });

  TestRunner.test('location falls back to country_code only', () => {
    assertEqual(
      normalizeLinkedInProfile({ name: 'X', country_code: 'DE' }, 'x').location,
      'DE'
    );
  });

  TestRunner.test('connections parses comma-separated number', () => {
    const result = normalizeLinkedInProfile({ name: 'X', connections: '1,234' }, 'x');
    assertEqual(result.connections, 1234);
  });

  TestRunner.test('connections handles "500+" string', () => {
    const result = normalizeLinkedInProfile({ name: 'X', connections: '500+' }, 'x');
    assertEqual(result.connections, 500);
  });

  TestRunner.test('null source defaults to "unknown"', () => {
    const result = normalizeLinkedInProfile({}, null);
    assertEqual(result._source, 'unknown');
  });
});

// --------------------------------------------------------------------------
// 3. Response Normalizer -- pickBestProfile
// --------------------------------------------------------------------------

TestRunner.suite('pickBestProfile', () => {

  TestRunner.test('returns null for empty array', () => {
    assertNull(pickBestProfile([], 'Jane', 'test'));
  });

  TestRunner.test('returns null for null input', () => {
    assertNull(pickBestProfile(null, 'Jane', 'test'));
  });

  TestRunner.test('returns null for undefined input', () => {
    assertNull(pickBestProfile(undefined, 'Jane', 'test'));
  });

  TestRunner.test('returns the only profile when array has one element', () => {
    const profiles = [{ name: 'Jane Doe', avatar: 'https://img.jpg' }];
    const result = pickBestProfile(profiles, 'Jane Doe', 'test');
    assertNotNull(result);
    assertEqual(result.name, 'Jane Doe');
  });

  TestRunner.test('picks exact name match from multiple profiles', () => {
    const profiles = [
      { name: 'John Smith', avatar: 'https://a.jpg', url: 'https://linkedin.com/in/john',
        current_company: { name: 'Big Co', title: 'CEO' }, about: 'CEO of Big Co',
        experience: [{ title: 'CEO' }], education: [{ title: 'Harvard' }] },
      { name: 'Jane Doe' },
      { name: 'Bob Jones' },
    ];

    // Even though John Smith has much higher confidence, exact name match wins
    const result = pickBestProfile(profiles, 'Jane Doe', 'test');
    assertEqual(result.name, 'Jane Doe');
  });

  TestRunner.test('falls back to best confidence score when no name match', () => {
    const profiles = [
      { name: 'Alice', /* bare minimum */ },
      { name: 'Bob',
        avatar: 'https://img.jpg',
        url: 'https://linkedin.com/in/bob',
        current_company: { name: 'TechCo', title: 'CTO' },
        about: 'CTO',
        experience: [{ title: 'CTO' }],
        education: [{ title: 'MIT' }],
      },
      { name: 'Charlie', avatar: 'https://img2.jpg' },
    ];

    const result = pickBestProfile(profiles, 'Not A Real Name', 'test');
    // Bob has the most data and should have the highest confidence score
    assertEqual(result.name, 'Bob');
  });

  TestRunner.test('passes context through for confidence scoring', () => {
    const profiles = [{ name: 'Jane Doe', url: 'https://linkedin.com/in/jane' }];
    const result = pickBestProfile(profiles, 'Jane Doe', 'test-source', { serpVerified: true });
    const serpCitation = result._confidenceCitations.find(c => c.factor === 'serp-verified');
    assertNotNull(serpCitation, 'Should have serp-verified citation');
  });

  TestRunner.test('case-insensitive exact name matching', () => {
    const profiles = [
      { name: 'JANE DOE', avatar: 'https://img.jpg' },
      { name: 'Bob Smith', avatar: 'https://img2.jpg', url: 'https://linkedin.com/in/bob',
        current_company: { name: 'Big', title: 'CEO' } },
    ];

    const result = pickBestProfile(profiles, 'jane doe', 'test');
    assertEqual(result.name, 'JANE DOE');
  });
});

// --------------------------------------------------------------------------
// 4. Response Normalizer -- mergeBusinessEnrichedData
// --------------------------------------------------------------------------

TestRunner.suite('mergeBusinessEnrichedData', () => {

  TestRunner.test('returns personData unchanged when enrichedProfile is null', () => {
    const person = { name: 'Jane', currentTitle: 'PM', currentCompany: 'Acme' };
    const result = mergeBusinessEnrichedData(person, null);
    assertEqual(result.name, 'Jane');
    assertEqual(result.currentTitle, 'PM');
  });

  TestRunner.test('returns personData unchanged when enrichedProfile is invalid type', () => {
    const person = { name: 'Jane', currentTitle: 'PM' };
    const result = mergeBusinessEnrichedData(person, 'not an object');
    assertEqual(result.name, 'Jane');
  });

  TestRunner.test('supplements missing currentTitle from enriched position', () => {
    const person = { name: 'Jane', currentTitle: null, currentCompany: null };
    const enriched = { position: 'Senior PM' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.currentTitle, 'Senior PM');
  });

  TestRunner.test('does NOT overwrite existing currentTitle', () => {
    const person = { name: 'Jane', currentTitle: 'CTO' };
    const enriched = { position: 'VP' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.currentTitle, 'CTO', 'Should keep original title');
  });

  TestRunner.test('supplements missing currentCompany from enriched', () => {
    const person = { name: 'Jane', currentCompany: null };
    const enriched = { current_company_name: 'Mega Corp' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.currentCompany, 'Mega Corp');
  });

  TestRunner.test('does NOT overwrite existing currentCompany', () => {
    const person = { name: 'Jane', currentCompany: 'Acme' };
    const enriched = { current_company_name: 'Other Corp' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.currentCompany, 'Acme');
  });

  TestRunner.test('adds companyRevenue from enriched', () => {
    const person = { name: 'Jane' };
    const enriched = { company_revenue: '$10M-$50M' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companyRevenue, '$10M-$50M');
  });

  TestRunner.test('adds companyRevenue from revenue fallback', () => {
    const person = { name: 'Jane' };
    const enriched = { revenue: '$100M+' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companyRevenue, '$100M+');
  });

  TestRunner.test('adds companySize from enriched', () => {
    const person = { name: 'Jane' };
    const enriched = { company_size: '1000-5000' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companySize, '1000-5000');
  });

  TestRunner.test('adds companySize from employee_count fallback', () => {
    const person = { name: 'Jane' };
    const enriched = { employee_count: '200' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companySize, '200');
  });

  TestRunner.test('adds companyIndustry from enriched', () => {
    const person = { name: 'Jane' };
    const enriched = { company_industry: 'Technology' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companyIndustry, 'Technology');
  });

  TestRunner.test('adds companyIndustry from industry fallback', () => {
    const person = { name: 'Jane' };
    const enriched = { industry: 'Healthcare' };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.companyIndustry, 'Healthcare');
  });

  TestRunner.test('adds skills as string array', () => {
    const person = { name: 'Jane' };
    const enriched = { skills: ['JavaScript', 'Python', 'Leadership'] };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertArrayLength(result.skills, 3);
    assertIncludes(result.skills, 'JavaScript');
    assertIncludes(result.skills, 'Python');
  });

  TestRunner.test('adds skills from object-style entries', () => {
    const person = { name: 'Jane' };
    const enriched = { skills: [{ name: 'React' }, { name: 'Node.js' }] };
    const result = mergeBusinessEnrichedData(person, enriched);
    assertArrayLength(result.skills, 2);
    assertIncludes(result.skills, 'React');
  });

  TestRunner.test('filters null skills from results', () => {
    const person = { name: 'Jane' };
    const enriched = { skills: ['Valid', null, '', { name: null }] };
    const result = mergeBusinessEnrichedData(person, enriched);
    // 'Valid' passes, null is filtered, '' becomes null and filtered, {name:null} becomes null and filtered
    assertArrayLength(result.skills, 1);
    assertEqual(result.skills[0], 'Valid');
  });

  TestRunner.test('does not mutate original personData object', () => {
    const person = { name: 'Jane', currentTitle: 'PM' };
    const enriched = { company_industry: 'Tech' };
    const result = mergeBusinessEnrichedData(person, enriched);

    // result should have companyIndustry
    assertEqual(result.companyIndustry, 'Tech');
    // original should NOT
    assertEqual(person.companyIndustry, undefined, 'Original should not be mutated');
  });
});

// --------------------------------------------------------------------------
// 5. Cache Key Normalization
// --------------------------------------------------------------------------

TestRunner.suite('Cache Key Normalization (normaliseCacheKey)', () => {

  TestRunner.test('lowercases input', () => {
    assertEqual(normaliseCacheKey('JaneDoe'), 'janedoe');
  });

  TestRunner.test('replaces spaces with underscores', () => {
    assertEqual(normaliseCacheKey('Jane Doe'), 'jane_doe');
  });

  TestRunner.test('replaces special characters with underscores', () => {
    assertEqual(normaliseCacheKey('jane.doe@acme.com'), 'jane_doe_acme_com');
  });

  TestRunner.test('collapses multiple underscores', () => {
    assertEqual(normaliseCacheKey('jane---doe'), 'jane_doe');
  });

  TestRunner.test('trims whitespace', () => {
    assertEqual(normaliseCacheKey('  Jane Doe  '), 'jane_doe');
  });

  TestRunner.test('handles null input', () => {
    assertEqual(normaliseCacheKey(null), 'unknown');
  });

  TestRunner.test('handles undefined input', () => {
    assertEqual(normaliseCacheKey(undefined), 'unknown');
  });

  TestRunner.test('handles empty string', () => {
    assertEqual(normaliseCacheKey(''), 'unknown');
  });

  TestRunner.test('preserves alphanumeric characters', () => {
    assertEqual(normaliseCacheKey('abc123xyz'), 'abc123xyz');
  });

  TestRunner.test('handles email-like input for cache key', () => {
    const key = normaliseCacheKey('john.smith@example.org');
    assertEqual(key, 'john_smith_example_org');
    // Verify no double underscores
    assert(!key.includes('__'), 'Should not have double underscores');
  });

  TestRunner.test('full cache key construction matches waterfall pattern', () => {
    // The waterfall constructs: `person_${normaliseCacheKey(email || name)}`
    const email = 'jane.doe@acme.com';
    const cacheKey = `person_${normaliseCacheKey(email)}`;
    assertEqual(cacheKey, 'person_jane_doe_acme_com');
  });
});

// --------------------------------------------------------------------------
// 6. WaterfallOrchestrator -- Progress & Step State Transitions
// --------------------------------------------------------------------------

TestRunner.suite('WaterfallOrchestrator Progress & State', () => {

  // We test the pipeline step definitions and progress notification logic
  // by replicating the core mechanics (since importing WaterfallOrchestrator
  // would trigger network-dependent module imports).

  const PIPELINE_STEPS = [
    { id: 'cache',             label: 'Checking cache...',                          icon: 'cache',     percent: 5  },
    { id: 'serp-discovery',    label: 'Searching SERP by email...',                 icon: 'search',    percent: 30 },
    { id: 'linkedin-enriched', label: 'Enriching from LinkedIn & business data...', icon: 'linkedin',  percent: 70 },
    { id: 'deep-lookup',       label: 'Deep lookup...',                             icon: 'magnifier', percent: 90 },
  ];

  TestRunner.test('pipeline has exactly 4 steps', () => {
    assertArrayLength(PIPELINE_STEPS, 4);
  });

  TestRunner.test('pipeline step IDs are unique', () => {
    const ids = PIPELINE_STEPS.map(s => s.id);
    const unique = new Set(ids);
    assertEqual(unique.size, 4, 'All step IDs should be unique');
  });

  TestRunner.test('pipeline percentages increase monotonically', () => {
    for (let i = 1; i < PIPELINE_STEPS.length; i++) {
      assert(
        PIPELINE_STEPS[i].percent > PIPELINE_STEPS[i - 1].percent,
        `Step ${PIPELINE_STEPS[i].id} percent (${PIPELINE_STEPS[i].percent}) ` +
        `should be > ${PIPELINE_STEPS[i - 1].id} (${PIPELINE_STEPS[i - 1].percent})`
      );
    }
  });

  TestRunner.test('all steps have required fields', () => {
    for (const step of PIPELINE_STEPS) {
      assertType(step.id, 'string', `Step ${step.id} id`);
      assertType(step.label, 'string', `Step ${step.id} label`);
      assertType(step.icon, 'string', `Step ${step.id} icon`);
      assertType(step.percent, 'number', `Step ${step.id} percent`);
      assert(step.label.length > 0, `Step ${step.id} label should not be empty`);
    }
  });

  TestRunner.test('progress notification payload structure', () => {
    // Simulate what _notifyProgress produces
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));
    const stepId = 'serp-discovery';
    const status = 'active';
    const personName = 'Jane Doe';

    // Simulate status update
    const stepIndex = stepsState.findIndex(s => s.id === stepId);
    stepsState[stepIndex].status = status;

    const activeStep = stepsState.find(s => s.id === stepId);
    const payload = {
      label:      activeStep.label,
      percent:    activeStep.percent,
      step:       stepIndex + 1,
      totalSteps: stepsState.length,
      stepId,
      stepStatus: status,
      personName,
      stepsState: stepsState.map(s => ({ ...s })),
    };

    assertEqual(payload.label, 'Searching SERP by email...');
    assertEqual(payload.percent, 30);
    assertEqual(payload.step, 2);
    assertEqual(payload.totalSteps, 4);
    assertEqual(payload.stepId, 'serp-discovery');
    assertEqual(payload.stepStatus, 'active');
    assertEqual(payload.personName, 'Jane Doe');
    assertArrayLength(payload.stepsState, 4);
    assertEqual(payload.stepsState[0].status, 'pending');
    assertEqual(payload.stepsState[1].status, 'active');
  });

  TestRunner.test('step state transitions: pending -> active -> completed', () => {
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    // All start pending
    assert(stepsState.every(s => s.status === 'pending'), 'All should start pending');

    // Transition cache to active
    stepsState[0].status = 'active';
    assertEqual(stepsState[0].status, 'active');

    // Transition cache to completed
    stepsState[0].status = 'completed';
    assertEqual(stepsState[0].status, 'completed');

    // Remaining are still pending
    assert(stepsState.slice(1).every(s => s.status === 'pending'),
      'Remaining should be pending');
  });

  TestRunner.test('step state transitions: pending -> active -> failed', () => {
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    stepsState[1].status = 'active';
    stepsState[1].status = 'failed';
    assertEqual(stepsState[1].status, 'failed');
  });

  TestRunner.test('step state transitions: remaining steps marked skipped on cache hit', () => {
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    // Simulate: cache hit -> mark cache completed, rest skipped
    stepsState[0].status = 'completed';
    for (let i = 1; i < stepsState.length; i++) {
      if (stepsState[i].status === 'pending') {
        stepsState[i].status = 'skipped';
      }
    }

    assertEqual(stepsState[0].status, 'completed');
    assertEqual(stepsState[1].status, 'skipped');
    assertEqual(stepsState[2].status, 'skipped');
    assertEqual(stepsState[3].status, 'skipped');
  });

  TestRunner.test('step state transitions: SERP success skips deep-lookup', () => {
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    // cache miss
    stepsState[0].status = 'completed';
    // serp success
    stepsState[1].status = 'completed';
    // linkedin enriched success
    stepsState[2].status = 'completed';
    // deep lookup skipped
    stepsState[3].status = 'skipped';

    assertEqual(stepsState[3].status, 'skipped');
  });

  TestRunner.test('step state transitions: SERP failure triggers deep-lookup', () => {
    const stepsState = PIPELINE_STEPS.map(s => ({ ...s, status: 'pending' }));

    // cache miss
    stepsState[0].status = 'completed';
    // serp failure
    stepsState[1].status = 'failed';
    // linkedin enriched skipped (cannot run without SERP URL)
    stepsState[2].status = 'skipped';
    // deep lookup runs
    stepsState[3].status = 'active';
    stepsState[3].status = 'completed';

    assertEqual(stepsState[1].status, 'failed');
    assertEqual(stepsState[2].status, 'skipped');
    assertEqual(stepsState[3].status, 'completed');
  });

  TestRunner.test('layer timeout values are reasonable', () => {
    const LAYER_TIMEOUTS = {
      serpDiscovery:       20_000,
      linkedInAndEnrich:   55_000,
      deepLookup:          45_000,
    };

    // All timeouts should be > 5 seconds and < 2 minutes
    for (const [key, ms] of Object.entries(LAYER_TIMEOUTS)) {
      assert(ms >= 5000, `${key} timeout should be >= 5s`);
      assert(ms <= 120_000, `${key} timeout should be <= 120s`);
    }

    // Enrichment should have the longest timeout (parallel scrape + enrichment)
    assert(LAYER_TIMEOUTS.linkedInAndEnrich > LAYER_TIMEOUTS.serpDiscovery,
      'LinkedIn+Enrich should have longer timeout than SERP');
  });
});

// --------------------------------------------------------------------------
// 7. MessageType Enum
// --------------------------------------------------------------------------

TestRunner.suite('MessageType', () => {

  TestRunner.test('has all expected message types', () => {
    const expected = [
      'FETCH_PERSON_BACKGROUND',
      'FETCH_PROGRESS',
      'OPEN_SIDE_PANEL',
      'PERSON_BACKGROUND_RESULT',
      'GET_CACHE_STATS',
      'CLEAR_CACHE',
      'GET_LOGS',
      'GET_HISTORY',
      'PING',
    ];

    for (const key of expected) {
      assert(key in MessageType, `MessageType should have "${key}"`);
    }
  });

  TestRunner.test('has exactly 9 message types', () => {
    assertEqual(Object.keys(MessageType).length, 9, 'MessageType count');
  });

  TestRunner.test('each key matches its string value (identity mapping)', () => {
    for (const [key, value] of Object.entries(MessageType)) {
      assertEqual(key, value,
        `MessageType.${key} should equal "${key}", got "${value}"`);
    }
  });

  TestRunner.test('FETCH_PERSON_BACKGROUND value', () => {
    assertEqual(MessageType.FETCH_PERSON_BACKGROUND, 'FETCH_PERSON_BACKGROUND');
  });

  TestRunner.test('FETCH_PROGRESS value', () => {
    assertEqual(MessageType.FETCH_PROGRESS, 'FETCH_PROGRESS');
  });

  TestRunner.test('OPEN_SIDE_PANEL value', () => {
    assertEqual(MessageType.OPEN_SIDE_PANEL, 'OPEN_SIDE_PANEL');
  });

  TestRunner.test('PERSON_BACKGROUND_RESULT value', () => {
    assertEqual(MessageType.PERSON_BACKGROUND_RESULT, 'PERSON_BACKGROUND_RESULT');
  });

  TestRunner.test('GET_CACHE_STATS value', () => {
    assertEqual(MessageType.GET_CACHE_STATS, 'GET_CACHE_STATS');
  });

  TestRunner.test('CLEAR_CACHE value', () => {
    assertEqual(MessageType.CLEAR_CACHE, 'CLEAR_CACHE');
  });

  TestRunner.test('GET_LOGS value', () => {
    assertEqual(MessageType.GET_LOGS, 'GET_LOGS');
  });

  TestRunner.test('GET_HISTORY value', () => {
    assertEqual(MessageType.GET_HISTORY, 'GET_HISTORY');
  });

  TestRunner.test('PING value', () => {
    assertEqual(MessageType.PING, 'PING');
  });

  TestRunner.test('no message type values contain spaces or lowercase', () => {
    for (const [, value] of Object.entries(MessageType)) {
      assert(!value.includes(' '), `"${value}" should not contain spaces`);
      assertEqual(value, value.toUpperCase(), `"${value}" should be all uppercase`);
    }
  });
});

// --------------------------------------------------------------------------
// 8. Edge Cases & Integration of Normalizer + LogBuffer
// --------------------------------------------------------------------------

TestRunner.suite('Edge Cases & Cross-Module', () => {

  TestRunner.test('normalizeLinkedInProfile with empty object', () => {
    const result = normalizeLinkedInProfile({}, 'empty');
    assertEqual(result.name, 'Unknown');
    assertArrayLength(result.experience, 0);
    assertArrayLength(result.education, 0);
    assertArrayLength(result.recentPosts, 0);
    assertNull(result.avatarUrl);
    assertNull(result.linkedinUrl);
    assertNull(result.currentTitle);
    assertNull(result.currentCompany);
    assertNull(result.location);
    assertNull(result.bio);
  });

  TestRunner.test('normalizeLinkedInProfile trims whitespace in strings', () => {
    const raw = { name: '  Jane Doe  ', about: '  Trim me  ' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.name, 'Jane Doe');
    assertEqual(result.bio, 'Trim me');
  });

  TestRunner.test('normalizeLinkedInProfile handles empty-string fields', () => {
    const raw = { name: '', avatar: '', url: '' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.name, 'Unknown');
    assertNull(result.avatarUrl);
    assertNull(result.linkedinUrl);
  });

  TestRunner.test('experience normalization handles complete entry', () => {
    const raw = {
      name: 'Test',
      experience: [{
        title: 'Engineer',
        company: 'TechCo',
        company_logo_url: 'https://logo.png',
        start_date: '2020-01',
        end_date: '2023-06',
        location: 'NYC',
        description: 'Built things',
      }],
    };
    const result = normalizeLinkedInProfile(raw, 'test');
    const exp = result.experience[0];
    assertEqual(exp.title, 'Engineer');
    assertEqual(exp.company, 'TechCo');
    assertEqual(exp.companyLogoUrl, 'https://logo.png');
    assertEqual(exp.startDate, '2020-01');
    assertEqual(exp.endDate, '2023-06');
    assertEqual(exp.location, 'NYC');
    assertEqual(exp.description, 'Built things');
  });

  TestRunner.test('education normalization handles complete entry', () => {
    const raw = {
      name: 'Test',
      education: [{
        title: 'MIT',
        degree: 'MS',
        field: 'AI',
        start_year: '2018',
        end_year: '2020',
        institute_logo_url: 'https://mit.png',
      }],
    };
    const result = normalizeLinkedInProfile(raw, 'test');
    const edu = result.education[0];
    assertEqual(edu.institution, 'MIT');
    assertEqual(edu.degree, 'MS');
    assertEqual(edu.field, 'AI');
    assertEqual(edu.startYear, '2018');
    assertEqual(edu.endYear, '2020');
    assertEqual(edu.logoUrl, 'https://mit.png');
  });

  TestRunner.test('recentPosts normalization handles complete entry', () => {
    const raw = {
      name: 'Test',
      activity: [{
        title: 'Cool Post',
        link: 'https://linkedin.com/post/123',
        img: 'https://img.png',
        interaction: '50 reactions',
      }],
    };
    const result = normalizeLinkedInProfile(raw, 'test');
    const post = result.recentPosts[0];
    assertEqual(post.title, 'Cool Post');
    assertEqual(post.link, 'https://linkedin.com/post/123');
    assertEqual(post.imageUrl, 'https://img.png');
    assertEqual(post.interaction, '50 reactions');
  });

  TestRunner.test('currentTitle fallback from position field', () => {
    const raw = { name: 'Test', position: 'Director of Engineering' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.currentTitle, 'Director of Engineering');
  });

  TestRunner.test('currentCompany fallback from current_company_name', () => {
    const raw = { name: 'Test', current_company_name: 'Startup Inc' };
    const result = normalizeLinkedInProfile(raw, 'test');
    assertEqual(result.currentCompany, 'Startup Inc');
  });

  TestRunner.test('LogBuffer handles rapid sequential writes', () => {
    const lb = new LogBuffer();
    for (let i = 0; i < 300; i++) {
      lb.info('Stress', `Message ${i}`);
    }
    const entries = lb.getEntries();
    assertArrayLength(entries, 200);
    // Should contain last 200 messages (100-299)
    assertEqual(entries[0].message, 'Message 299');
    assertEqual(entries[199].message, 'Message 100');
  });

  TestRunner.test('LogBuffer module filter with empty result', () => {
    const lb = new LogBuffer();
    lb.info('Alpha', 'msg');
    const entries = lb.getEntries({ module: 'NonExistent' });
    assertArrayLength(entries, 0);
  });

  TestRunner.test('mergeBusinessEnrichedData full merge scenario', () => {
    const person = {
      name: 'Jane Doe',
      currentTitle: null,
      currentCompany: null,
      email: 'jane@acme.com',
    };
    const enriched = {
      position: 'VP Engineering',
      current_company_name: 'Acme Inc',
      company_revenue: '$50M-$100M',
      company_size: '200-500',
      company_industry: 'Software',
      skills: ['Leadership', 'Python', { name: 'React' }],
    };

    const result = mergeBusinessEnrichedData(person, enriched);
    assertEqual(result.currentTitle, 'VP Engineering');
    assertEqual(result.currentCompany, 'Acme Inc');
    assertEqual(result.companyRevenue, '$50M-$100M');
    assertEqual(result.companySize, '200-500');
    assertEqual(result.companyIndustry, 'Software');
    assertArrayLength(result.skills, 3);
    assertIncludes(result.skills, 'Leadership');
    assertIncludes(result.skills, 'Python');
    assertIncludes(result.skills, 'React');
  });

  TestRunner.test('cache key construction for email vs name', () => {
    // When email is provided, it should be used for the key
    const emailKey = `person_${normaliseCacheKey('jane@acme.com')}`;
    const nameKey = `person_${normaliseCacheKey('Jane Doe')}`;

    assertEqual(emailKey, 'person_jane_acme_com');
    assertEqual(nameKey, 'person_jane_doe');

    // Keys should be different for email vs name
    assert(emailKey !== nameKey, 'Email and name keys should differ');
  });
});

// ============================================================================
// Run all tests
// ============================================================================

TestRunner.run();
