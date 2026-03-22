#!/usr/bin/env node
/**
 * tests/api-smoke-test.js
 *
 * PreMeet — API Smoke Test Suite
 *
 * Tests all 4 API layers end-to-end using live API calls.
 * Run from the terminal:
 *
 *   node tests/api-smoke-test.js
 *   node tests/api-smoke-test.js --email=person@company.com --name="First Last"
 *
 * Environment:
 *   BPI_API_TOKEN  — API token (falls back to hardcoded demo token)
 *
 * Each layer is tested independently and prints PASS/FAIL with timing.
 */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_TOKEN = process.env.BPI_API_TOKEN ||
  '30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9';

const CUSTOMER_ID = 'hl_cf5c4907';
const ZONE        = 'serp';
const DATASET_ID  = 'gd_l1viktl72bvl7bjuj0';

const SERP_SEND_URL   = 'https://api.brightdata.com/unblocker/req';
const SERP_RESULT_URL = 'https://api.brightdata.com/unblocker/get_result';
const DEEP_LOOKUP_URL = 'https://api.brightdata.com/datasets/deep_lookup/v1';
const SCRAPER_URL     = 'https://api.brightdata.com/datasets/v3/scrape';
const FILTER_URL      = 'https://api.brightdata.com/datasets/filter';
const SNAPSHOT_URL    = 'https://api.brightdata.com/datasets/snapshots';

// ─── CLI args ────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=') || true];
    })
);

// Test inputs — override with --email=... --name=... --company=...
const TEST_EMAIL   = args.email   || 'itamara@similarweb.com';

// Derive name from email if not provided (itamara@company.com → "Itamara")
function deriveNameFromEmail(email) {
  if (!email) return '';
  const local = email.split('@')[0].replace(/[._\-+]/g, ' ').trim();
  return local.charAt(0).toUpperCase() + local.slice(1);
}
function deriveCompanyFromEmail(email) {
  if (!email || !email.includes('@')) return '';
  const domain = email.split('@')[1];
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const TEST_NAME    = args.name    || deriveNameFromEmail(TEST_EMAIL);
const TEST_COMPANY = args.company || deriveCompanyFromEmail(TEST_EMAIL);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function authHeaders() {
  return {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type':  'application/json',
  };
}

function authHeadersGet() {
  return { 'Authorization': `Bearer ${API_TOKEN}` };
}

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let totalTests  = 0;
let passedTests = 0;
let failedTests = 0;

function report(layer, passed, detail, elapsedMs) {
  totalTests++;
  if (passed) passedTests++;
  else failedTests++;

  const tag = passed ? PASS : FAIL;
  console.log(`  ${tag}  ${layer} (${elapsedMs}ms) — ${detail}`);
}

function reportSkip(layer, reason) {
  totalTests++;
  console.log(`  ${SKIP}  ${layer} — ${reason}`);
}

// ─── Layer 1: SERP Discovery ─────────────────────────────────────────────────

async function testSERP() {
  console.log(`\n${BOLD}Layer 1: SERP Discovery${RESET}`);

  // Build a search query: use name+company if available, otherwise derive from email
  let query;
  if (TEST_NAME) {
    query = `${TEST_NAME}${TEST_COMPANY ? ' ' + TEST_COMPANY : ''}`;
  } else if (TEST_EMAIL) {
    // Extract local part and domain for better search (itamara@similarweb.com → "itamara similarweb")
    const [local, domain] = TEST_EMAIL.split('@');
    const domainName = domain ? domain.split('.')[0] : '';
    query = `${local} ${domainName}`.trim();
  } else {
    query = TEST_COMPANY || '';
  }
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in ${query}`)}`;

  const start = Date.now();

  try {
    // Step 1: Send request
    const sendRes = await fetch(
      `${SERP_SEND_URL}?customer=${CUSTOMER_ID}&zone=${ZONE}`,
      {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ url: searchUrl }),
      }
    );

    if (!sendRes.ok) {
      const body = await sendRes.text();
      report('SERP:send', false, `HTTP ${sendRes.status}: ${body.slice(0, 150)}`, Date.now() - start);
      return null;
    }

    const responseId = sendRes.headers.get('x-response-id');
    if (!responseId) {
      report('SERP:send', false, 'No x-response-id header', Date.now() - start);
      return null;
    }

    console.log(`    x-response-id: ${responseId}`);

    // Step 2: Poll for result
    let result = null;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);

      const pollRes = await fetch(
        `${SERP_RESULT_URL}?customer=${CUSTOMER_ID}&zone=${ZONE}&response_id=${responseId}`,
        { headers: authHeadersGet() }
      );

      if (pollRes.status === 202) {
        console.log(`    Polling... (attempt ${i + 1})`);
        continue;
      }

      if (pollRes.ok) {
        result = await pollRes.text();
        break;
      }

      report('SERP:poll', false, `HTTP ${pollRes.status}`, Date.now() - start);
      return null;
    }

    if (!result) {
      report('SERP:poll', false, 'Timed out after 30s', Date.now() - start);
      return null;
    }

    // Step 3: Extract LinkedIn URL
    const urlMatch = result.match(
      /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i
    );

    if (urlMatch) {
      // Normalize country subdomain (il.linkedin.com → www.linkedin.com)
      const linkedInUrl = urlMatch[0].split('?')[0].replace(/\/\/[a-z]{2,3}\.linkedin/, '//www.linkedin');
      report('SERP', true, `Found: ${linkedInUrl}`, Date.now() - start);
      return linkedInUrl;
    } else {
      report('SERP', false, `No LinkedIn URL in ${result.length} chars of HTML`, Date.now() - start);
      return null;
    }
  } catch (err) {
    report('SERP', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Layer 2: Deep Lookup (trigger_enrichment) ───────────────────────────────

async function testDeepLookup() {
  console.log(`\n${BOLD}Layer 2: Deep Lookup (trigger_enrichment)${RESET}`);

  const input = {
    email:     TEST_EMAIL,
    full_name: TEST_NAME || deriveNameFromEmail(TEST_EMAIL) || 'Unknown',
    company:   TEST_COMPANY || deriveCompanyFromEmail(TEST_EMAIL) || 'Unknown',
  };

  const spec = {
    input_schema: {
      type: 'object',
      properties: {
        email:     { type: 'string', description: 'Email address' },
        full_name: { type: 'string', description: 'Full name' },
        company:   { type: 'string', description: 'Company name' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        linkedin_profile_url: {
          type: 'string',
          description: "The full LinkedIn profile URL (https://linkedin.com/in/...). If unavailable, return 'LinkedIn profile not found.'",
        },
        full_name: { type: 'string', description: 'Full name on LinkedIn.' },
        current_position: { type: 'string', description: 'Current job title and company.' },
        linkedin_id: { type: 'string', description: 'LinkedIn profile slug/ID from the URL.' },
      },
    },
  };

  const start = Date.now();

  try {
    // Step 1: Trigger
    const triggerRes = await fetch(`${DEEP_LOOKUP_URL}/trigger_enrichment`, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ spec, input: [input] }),
    });

    if (!triggerRes.ok) {
      const body = await triggerRes.text();
      report('DeepLookup:trigger', false, `HTTP ${triggerRes.status}: ${body.slice(0, 200)}`, Date.now() - start);
      return null;
    }

    const triggerData = await triggerRes.json();
    const requestId = triggerData.request_id;

    if (!requestId) {
      report('DeepLookup:trigger', false, 'No request_id: ' + JSON.stringify(triggerData).slice(0, 150), Date.now() - start);
      return null;
    }

    console.log(`    request_id: ${requestId}, status: ${triggerData.status}, max_cost: ${triggerData.max_cost}`);

    // Step 2: Poll
    for (let i = 0; i < 30; i++) {
      await sleep(3000);

      const statusRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}/status`, {
        headers: authHeadersGet(),
      });

      if (!statusRes.ok) {
        console.log(`    Poll attempt ${i + 1}: HTTP ${statusRes.status}`);
        continue;
      }

      const statusData = await statusRes.json();
      console.log(`    Poll attempt ${i + 1}: ${statusData.status}`);

      if (statusData.status === 'completed' || statusData.status === 'ready') break;
      if (statusData.status === 'failed' || statusData.status === 'error') {
        report('DeepLookup:poll', false, `Failed: ${statusData.error || 'unknown'}`, Date.now() - start);
        return null;
      }
    }

    // Step 3: Download
    const dataRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}`, {
      headers: authHeadersGet(),
    });

    if (!dataRes.ok) {
      report('DeepLookup:download', false, `HTTP ${dataRes.status}`, Date.now() - start);
      return null;
    }

    const responseData = await dataRes.json();
    console.log(`    Entities: ${responseData.data ? Object.keys(responseData.data).length : 0}`);

    // Extract LinkedIn URL
    const dataBlock = responseData.data;
    let linkedInUrl = null;

    if (dataBlock && typeof dataBlock === 'object') {
      for (const entityId of Object.keys(dataBlock)) {
        const entity = dataBlock[entityId];
        const value = entity?.value;
        if (!value) continue;

        console.log(`    Entity ${entityId}: confidence=${entity.confidence}`);
        console.log(`    Full response: ${JSON.stringify(value).slice(0, 400)}`);

        const url = value.linkedin_profile_url || value.linkedin_url;
        if (url && /linkedin\.com\/in\//i.test(url)) {
          linkedInUrl = url.split('?')[0];
          console.log(`    LinkedIn URL: ${linkedInUrl}`);
          console.log(`    Name: ${value.full_name || 'n/a'}, Position: ${value.current_position || 'n/a'}`);
          break;
        }

        // Fallback: scan all string values for a LinkedIn URL
        if (!linkedInUrl) {
          for (const v of Object.values(value)) {
            if (typeof v !== 'string') continue;
            const match = v.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
            if (match) {
              linkedInUrl = match[0].split('?')[0];
              console.log(`    LinkedIn URL (via scan): ${linkedInUrl}`);
              break;
            }
          }
        }
      }
    }

    if (linkedInUrl) {
      report('DeepLookup', true, `Found: ${linkedInUrl}`, Date.now() - start);
    } else {
      report('DeepLookup', false, 'No LinkedIn URL in response', Date.now() - start);
    }
    return linkedInUrl;
  } catch (err) {
    report('DeepLookup', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Layer 3: LinkedIn Scraper (WSA) ─────────────────────────────────────────

async function testLinkedInScraper(linkedInUrl) {
  console.log(`\n${BOLD}Layer 3: LinkedIn Scraper (WSA)${RESET}`);

  if (!linkedInUrl) {
    reportSkip('Scraper', 'No LinkedIn URL from previous layers');
    return null;
  }

  const start = Date.now();

  try {
    const res = await fetch(
      `${SCRAPER_URL}?dataset_id=${DATASET_ID}&notify=false&include_errors=true`,
      {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ input: [{ url: linkedInUrl }] }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      report('Scraper:request', false, `HTTP ${res.status}: ${body.slice(0, 200)}`, Date.now() - start);
      return null;
    }

    const data = await res.json();

    // Direct response (single object or array) or snapshot
    let profiles = [];
    if (Array.isArray(data) && data.length > 0) {
      profiles = data;
      console.log(`    Direct response: ${profiles.length} profile(s)`);
    } else if (data && typeof data === 'object' && !data.snapshot_id && data.name) {
      // Single profile object returned
      profiles = [data];
      console.log(`    Direct response: 1 profile (single object)`);
    } else if (data?.snapshot_id) {
      console.log(`    Snapshot mode: ${data.snapshot_id}`);

      // Poll snapshot (up to 50 attempts = ~100s)
      let scraperReady = false;
      for (let i = 0; i < 50; i++) {
        await sleep(2000);
        const statusRes = await fetch(`${SNAPSHOT_URL}/${data.snapshot_id}`, {
          headers: authHeadersGet(),
        });
        if (!statusRes.ok) {
          if (statusRes.status === 404 && i < 5) continue; // not registered yet
          console.log(`    Poll ${i + 1}: HTTP ${statusRes.status}`);
          continue;
        }

        const statusData = await statusRes.json();
        if (i < 3 || i % 5 === 0 || statusData.status === 'ready' || statusData.status === 'failed') {
          console.log(`    Poll ${i + 1}: ${statusData.status}`);
        }

        if (statusData.status === 'ready') { scraperReady = true; break; }
        if (statusData.status === 'failed') {
          report('Scraper:snapshot', false, `Snapshot failed: ${statusData.error || 'unknown'}`, Date.now() - start);
          return null;
        }
      }

      if (!scraperReady) {
        report('Scraper:snapshot', false, 'Snapshot not ready after 100s', Date.now() - start);
        return null;
      }

      // Download
      const dlRes = await fetch(`${SNAPSHOT_URL}/${data.snapshot_id}/download?format=json`, {
        headers: authHeadersGet(),
      });
      if (dlRes.ok) {
        const raw = await dlRes.json();
        profiles = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
      }
    }

    if (profiles.length === 0) {
      report('Scraper', false, 'No profiles returned', Date.now() - start);
      return null;
    }

    const p = profiles[0];
    const linkedInId = p.linkedin_id || p.id || null;

    console.log(`    Name: ${p.name || 'n/a'}`);
    console.log(`    linkedin_id: ${p.linkedin_id || 'n/a'}`);
    console.log(`    id (full slug): ${p.id || 'n/a'}`);
    console.log(`    Title: ${p.current_company_position || p.position || 'n/a'}`);
    console.log(`    Company: ${p.current_company_name || 'n/a'}`);

    report('Scraper', true, `linkedin_id="${linkedInId}", name="${p.name}"`, Date.now() - start);
    return linkedInId;
  } catch (err) {
    report('Scraper', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Layer 4: Filter API ─────────────────────────────────────────────────────

async function testFilterAPI(linkedInId) {
  console.log(`\n${BOLD}Layer 4: Filter API${RESET}`);

  if (!linkedInId) {
    reportSkip('Filter', 'No LinkedIn ID from previous layers');
    return null;
  }

  const start = Date.now();

  try {
    // Step 1: Create filter
    const createRes = await fetch(FILTER_URL, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({
        dataset_id: DATASET_ID,
        filter: {
          name:     'linkedin_id',
          operator: '=',
          value:    linkedInId,
        },
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      report('Filter:create', false, `HTTP ${createRes.status}: ${body.slice(0, 200)}`, Date.now() - start);
      return null;
    }

    const createData = await createRes.json();
    const snapshotId = createData.snapshot_id;

    if (!snapshotId) {
      report('Filter:create', false, 'No snapshot_id', Date.now() - start);
      return null;
    }

    console.log(`    snapshot_id: ${snapshotId}`);

    // Step 2: Poll snapshot (up to 40 attempts = ~80s)
    let snapshotReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(2000);

      const statusRes = await fetch(`${SNAPSHOT_URL}/${snapshotId}`, {
        headers: authHeadersGet(),
      });

      if (statusRes.status === 404) {
        console.log(`    Poll attempt ${i + 1}: 404 (not registered yet)`);
        continue;
      }

      if (!statusRes.ok) continue;

      const statusData = await statusRes.json();
      if (i < 5 || i % 5 === 0 || statusData.status === 'ready' || statusData.status === 'failed') {
        console.log(`    Poll attempt ${i + 1}: ${statusData.status}`);
      }

      if (statusData.status === 'ready') { snapshotReady = true; break; }
      if (statusData.status === 'failed') {
        report('Filter:poll', false, 'Snapshot failed', Date.now() - start);
        return null;
      }
    }

    if (!snapshotReady) {
      report('Filter:poll', false, 'Snapshot not ready after 80s polling', Date.now() - start);
      return null;
    }

    // Step 3: Download (handle JSON, NDJSON, and not-ready text)
    await sleep(1000); // brief delay to let snapshot finalize
    const dlRes = await fetch(`${SNAPSHOT_URL}/${snapshotId}/download?format=json`, {
      headers: authHeadersGet(),
    });

    if (!dlRes.ok) {
      report('Filter:download', false, `HTTP ${dlRes.status}`, Date.now() - start);
      return null;
    }

    const rawText = await dlRes.text();
    let data;
    try {
      if (rawText.startsWith('[') || rawText.startsWith('{')) {
        data = JSON.parse(rawText);
      } else if (rawText.includes('\n') && rawText.trim().split('\n').every(l => l.trim().startsWith('{'))) {
        // NDJSON (newline-delimited JSON)
        data = rawText.trim().split('\n').map(line => JSON.parse(line.trim()));
      } else {
        report('Filter:download', false, `Non-JSON response: "${rawText.slice(0, 100)}"`, Date.now() - start);
        return null;
      }
    } catch (parseErr) {
      report('Filter:download', false, `JSON parse error: ${parseErr.message} — raw: "${rawText.slice(0, 100)}"`, Date.now() - start);
      return null;
    }

    if (!Array.isArray(data)) data = [data];

    if (data.length === 0) {
      report('Filter', false, `No data returned`, Date.now() - start);
      return null;
    }

    const p = data[0];
    console.log(`    Records: ${data.length}`);
    console.log(`    Name: ${p.name || 'n/a'}`);
    console.log(`    Title: ${p.current_company_position || p.position || 'n/a'}`);
    console.log(`    Company: ${p.current_company_name || 'n/a'}`);
    console.log(`    Experience entries: ${(p.experience || []).length}`);
    console.log(`    Education entries: ${(p.education || []).length}`);
    console.log(`    Recent posts: ${(p.activity || p.posts || []).length}`);

    report('Filter', true, `${data.length} record(s), name="${p.name}"`, Date.now() - start);
    return data;
  } catch (err) {
    report('Filter', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Layer 5: Deep Lookup Enrich ─────────────────────────────────────────

async function testDeepLookupEnrich(linkedInUrl) {
  console.log(`\n${BOLD}Layer 5: Deep Lookup Enrich (trigger_enrichment)${RESET}`);

  if (!linkedInUrl) {
    reportSkip('DeepLookup:Enrich', 'No LinkedIn URL from previous layers');
    return null;
  }

  const spec = {
    input_schema: {
      type: 'object',
      properties: {
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL to enrich' },
        linkedin_id:  { type: 'string', description: 'LinkedIn profile slug/ID' },
        full_name:    { type: 'string', description: 'Full name of the person' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        current_position: { type: 'string', description: 'Current job title and company.' },
        work_experience:  {
          type: 'string',
          description: 'A summary of the most recent 3-5 work positions including company name, title, and dates.',
        },
        education: {
          type: 'string',
          description: 'Education background including institution names and degrees.',
        },
        skills: { type: 'string', description: 'Comma-separated list of key professional skills.' },
      },
    },
  };

  // Extract linkedin_id from URL (e.g. https://linkedin.com/in/john-doe → john-doe)
  const idMatch = linkedInUrl.match(/\/in\/([a-zA-Z0-9\-_%]+)/i);
  const linkedInId = idMatch ? idMatch[1] : '';

  const input = {
    linkedin_url: linkedInUrl,
    linkedin_id:  linkedInId,
    full_name:    TEST_NAME || 'Unknown',
  };

  const start = Date.now();

  try {
    // Trigger
    const triggerRes = await fetch(`${DEEP_LOOKUP_URL}/trigger_enrichment`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ spec, input: [input] }),
    });

    if (!triggerRes.ok) {
      const body = await triggerRes.text();
      report('DeepLookup:Enrich:trigger', false, `HTTP ${triggerRes.status}: ${body.slice(0, 200)}`, Date.now() - start);
      return null;
    }

    const triggerData = await triggerRes.json();
    const requestId = triggerData.request_id;

    if (!requestId) {
      report('DeepLookup:Enrich:trigger', false, 'No request_id', Date.now() - start);
      return null;
    }

    console.log(`    request_id: ${requestId}, status: ${triggerData.status}`);

    // Poll
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const statusRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}/status`, {
        headers: authHeadersGet(),
      });
      if (!statusRes.ok) { console.log(`    Poll ${i + 1}: HTTP ${statusRes.status}`); continue; }
      const statusData = await statusRes.json();
      console.log(`    Poll ${i + 1}: ${statusData.status}`);
      if (statusData.status === 'completed' || statusData.status === 'ready') break;
      if (statusData.status === 'failed' || statusData.status === 'error') {
        report('DeepLookup:Enrich', false, `Failed: ${statusData.error || 'unknown'}`, Date.now() - start);
        return null;
      }
    }

    // Download
    const dataRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}`, { headers: authHeadersGet() });
    if (!dataRes.ok) {
      report('DeepLookup:Enrich:download', false, `HTTP ${dataRes.status}`, Date.now() - start);
      return null;
    }

    const responseData = await dataRes.json();
    const dataBlock = responseData.data;
    let enrichResult = null;

    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock)[0];
      enrichResult = dataBlock[firstKey]?.value || null;
    }

    if (enrichResult) {
      console.log(`    Position: ${enrichResult.current_position || 'n/a'}`);
      console.log(`    Work Experience: ${(enrichResult.work_experience || '').slice(0, 200) || 'n/a'}`);
      console.log(`    Education: ${(enrichResult.education || '').slice(0, 200) || 'n/a'}`);
      console.log(`    Skills: ${(enrichResult.skills || '').slice(0, 150) || 'n/a'}`);
      report('DeepLookup:Enrich', true, `Got position, experience, education, skills`, Date.now() - start);
    } else {
      report('DeepLookup:Enrich', false, 'No enriched data in response', Date.now() - start);
    }
    return enrichResult;
  } catch (err) {
    report('DeepLookup:Enrich', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Layer 6: Deep Lookup Company Intel ─────────────────────────────────────

async function testDeepLookupCompanyIntel(companyName, personName, jobTitle, linkedInUrl) {
  console.log(`\n${BOLD}Layer 6: Deep Lookup Company Intel (trigger_enrichment)${RESET}`);

  if (!companyName) {
    reportSkip('DeepLookup:CompanyIntel', 'No company name from previous layers');
    return null;
  }

  const spec = {
    input_schema: {
      type: 'object',
      properties: {
        full_name:    { type: 'string', description: 'Full name of the person' },
        company_name: { type: 'string', description: 'Name of the company the person works at' },
        job_title:    { type: 'string', description: 'Current job title of the person' },
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL of the person' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        company_description:  { type: 'string', description: "2-3 sentence description of company. If unavailable, return ''." },
        company_industry:     { type: 'string', description: "Primary industry/sector. If unavailable, return ''." },
        company_website:      { type: 'string', description: "Company website URL. If unavailable, return ''." },
        company_founded_year: { type: 'string', description: "Year founded. If unavailable, return ''." },
        company_headquarters: { type: 'string', description: "HQ city and country. If unavailable, return ''." },
        company_funding:      { type: 'string', description: "Funding details. If unavailable, return ''." },
        products_services:    { type: 'string', description: "Main products/services. If unavailable, return ''." },
        technologies:         { type: 'string', description: "Key technologies. If unavailable, return ''." },
        recent_news:          { type: 'string', description: "Recent news headlines. If unavailable, return ''." },
      },
    },
  };

  const input = {
    company_name: companyName,
    full_name:    personName || 'Unknown',
    job_title:    jobTitle || 'Unknown',
    linkedin_url: linkedInUrl || 'Unknown',
  };

  const start = Date.now();

  try {
    // Trigger
    const triggerRes = await fetch(`${DEEP_LOOKUP_URL}/trigger_enrichment`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ spec, input: [input] }),
    });

    if (!triggerRes.ok) {
      const body = await triggerRes.text();
      report('CompanyIntel:trigger', false, `HTTP ${triggerRes.status}: ${body.slice(0, 200)}`, Date.now() - start);
      return null;
    }

    const triggerData = await triggerRes.json();
    const requestId = triggerData.request_id;

    if (!requestId) {
      report('CompanyIntel:trigger', false, 'No request_id', Date.now() - start);
      return null;
    }

    console.log(`    request_id: ${requestId}, status: ${triggerData.status}`);

    // Poll
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const statusRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}/status`, {
        headers: authHeadersGet(),
      });
      if (!statusRes.ok) { console.log(`    Poll ${i + 1}: HTTP ${statusRes.status}`); continue; }
      const statusData = await statusRes.json();
      console.log(`    Poll ${i + 1}: ${statusData.status}`);
      if (statusData.status === 'completed' || statusData.status === 'ready') break;
      if (statusData.status === 'failed' || statusData.status === 'error') {
        report('CompanyIntel', false, `Failed: ${statusData.error || 'unknown'}`, Date.now() - start);
        return null;
      }
    }

    // Download
    const dataRes = await fetch(`${DEEP_LOOKUP_URL}/request/${requestId}`, { headers: authHeadersGet() });
    if (!dataRes.ok) {
      report('CompanyIntel:download', false, `HTTP ${dataRes.status}`, Date.now() - start);
      return null;
    }

    const responseData = await dataRes.json();
    const dataBlock = responseData.data;
    let companyResult = null;

    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock)[0];
      companyResult = dataBlock[firstKey]?.value || null;
    }

    if (companyResult) {
      const fields = ['company_description', 'company_industry', 'company_website',
        'company_founded_year', 'company_headquarters', 'company_funding',
        'products_services', 'technologies', 'recent_news'];
      let populated = 0;
      for (const f of fields) {
        const val = companyResult[f];
        if (val && val.trim()) {
          populated++;
          console.log(`    ${f}: ${val.slice(0, 120)}`);
        }
      }
      report('CompanyIntel', true, `${populated}/${fields.length} fields populated`, Date.now() - start);
    } else {
      report('CompanyIntel', false, 'No company data in response', Date.now() - start);
    }
    return companyResult;
  } catch (err) {
    report('CompanyIntel', false, err.message, Date.now() - start);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}║     PreMeet — Full API Smoke Test               ║${RESET}`);
  console.log(`${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`  Test inputs:`);
  console.log(`    Name:    ${TEST_NAME || '(none)'}`);
  console.log(`    Email:   ${TEST_EMAIL || '(none)'}`);
  console.log(`    Company: ${TEST_COMPANY || '(none)'}`);
  console.log(`    Token:   ${API_TOKEN.slice(0, 8)}...${API_TOKEN.slice(-4)}`);

  const totalStart = Date.now();

  // Layer 1: SERP Discovery
  let linkedInUrl = await testSERP();

  // Layer 2: Deep Lookup Discovery (requires email)
  let deepLookupUrl = null;
  if (TEST_EMAIL) {
    deepLookupUrl = await testDeepLookup();
  } else {
    console.log(`\n${BOLD}Layer 2: Deep Lookup (trigger_enrichment)${RESET}`);
    reportSkip('DeepLookup', 'No email provided (required by API). Use --email=... to test.');
  }

  // Use whichever URL we found
  if (!linkedInUrl && deepLookupUrl) {
    linkedInUrl = deepLookupUrl;
    console.log(`\n  Using Deep Lookup URL for subsequent layers.`);
  }

  // Layer 3: LinkedIn Scraper
  const linkedInId = await testLinkedInScraper(linkedInUrl);

  // Layer 4: Filter API
  const filterData = await testFilterAPI(linkedInId);

  // Extract person details for enrichment layers
  let scraperName = TEST_NAME;
  let scraperCompany = TEST_COMPANY;
  let scraperTitle = '';

  if (filterData && filterData.length > 0) {
    const p = filterData[0];
    scraperName = scraperName || p.name || '';
    scraperCompany = scraperCompany || p.current_company_name || '';
    scraperTitle = p.current_company_position || p.position || '';
  }

  // Layer 5: Deep Lookup Enrich (uses LinkedIn URL)
  await testDeepLookupEnrich(linkedInUrl);

  // Layer 6: Deep Lookup Company Intel (uses company name from scraper/filter)
  await testDeepLookupCompanyIntel(scraperCompany, scraperName, scraperTitle, linkedInUrl);

  // Summary
  const totalMs = Date.now() - totalStart;
  console.log(`\n${BOLD}${'─'.repeat(62)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}  ${passedTests}/${totalTests} passed, ${failedTests} failed  (${(totalMs / 1000).toFixed(1)}s total)`);
  console.log(`${'─'.repeat(62)}`);

  process.exit(failedTests > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
