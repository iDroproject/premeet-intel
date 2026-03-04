/**
 * background/api/bright-data-deep-lookup.js
 *
 * Bright People Intel – Bright Data Deep Lookup v1 (trigger_enrichment)
 *
 * Uses the Deep Lookup trigger_enrichment endpoint with an inline spec
 * to find a person's LinkedIn profile from email/name/company.
 *
 *   1. POST /trigger_enrichment  → returns { request_id, status: "queued" }
 *   2. GET  /request/{id}/status → poll until completed
 *   3. GET  /request/{id}        → download enriched results
 *
 * Base URL: https://api.brightdata.com/datasets/deep_lookup/v1
 *
 * @module bright-data-deep-lookup
 */

'use strict';

const LOG_PREFIX = '[BPI][DeepLookup]';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.brightdata.com/datasets/deep_lookup/v1';

const POLL_INTERVAL_MS    = 3000;
const MAX_POLL_ATTEMPTS   = 30;   // ~90 s total
const DEEP_LOOKUP_TIMEOUT_MS = 120_000;

// ─── Spec Definitions ────────────────────────────────────────────────────────

/**
 * Inline spec for LinkedIn profile discovery from email/name/company.
 */
const LINKEDIN_DISCOVERY_SPEC = {
  input_schema: {
    type: 'object',
    properties: {
      email: {
        type: 'string',
        description: 'Email address of the person to find on LinkedIn',
      },
      full_name: {
        type: 'string',
        description: 'Full name of the person',
      },
      company: {
        type: 'string',
        description: 'Current company or employer name',
      },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      linkedin_profile_url: {
        type: 'string',
        description:
          "The full LinkedIn profile URL (https://linkedin.com/in/...) for the person. " +
          "If unavailable, return 'LinkedIn profile not found.'",
      },
      full_name: {
        type: 'string',
        description: 'Full name as it appears on the LinkedIn profile.',
      },
      current_position: {
        type: 'string',
        description:
          'Current job title and company as listed on LinkedIn. ' +
          "If unavailable, return 'Position unavailable.'",
      },
      linkedin_id: {
        type: 'string',
        description:
          'The LinkedIn profile slug/ID extracted from the profile URL ' +
          '(the part after /in/ in the URL). If unavailable, return empty string.',
      },
    },
  },
};

/**
 * Inline spec for enriching a known LinkedIn profile with additional data.
 */
const LINKEDIN_ENRICHMENT_SPEC = {
  input_schema: {
    type: 'object',
    properties: {
      linkedin_url: {
        type: 'string',
        description: 'LinkedIn profile URL to enrich',
      },
      linkedin_id: {
        type: 'string',
        description: 'LinkedIn profile slug/ID',
      },
      full_name: {
        type: 'string',
        description: 'Full name of the person',
      },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      current_position: {
        type: 'string',
        description: 'Current job title and company.',
      },
      work_experience: {
        type: 'string',
        description:
          'A summary of the most recent 3-5 work positions including company name, ' +
          'title, and dates. If unavailable, return empty string.',
      },
      education: {
        type: 'string',
        description:
          'Education background including institution names and degrees. ' +
          'If unavailable, return empty string.',
      },
      skills: {
        type: 'string',
        description: 'Comma-separated list of key professional skills.',
      },
    },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(apiToken) {
  return {
    'Authorization': `Bearer ${apiToken}`,
    'Content-Type':  'application/json',
  };
}

function authHeadersGet(apiToken) {
  return { 'Authorization': `Bearer ${apiToken}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a LinkedIn profile URL from trigger_enrichment results.
 *
 * The response shape is:
 *   { data: { "<entity_id>": { value: { linkedin_profile_url, ... }, confidence, ... } } }
 *
 * @param {Object} responseData  Full response from GET /request/{id}.
 * @returns {string|null}
 */
function extractLinkedInUrl(responseData) {
  // Navigate the nested data structure.
  const dataBlock = responseData?.data;
  if (dataBlock && typeof dataBlock === 'object') {
    for (const entityId of Object.keys(dataBlock)) {
      const entity = dataBlock[entityId];
      const value = entity?.value;
      if (!value || typeof value !== 'object') continue;

      const url =
        value.linkedin_profile_url || value.linkedin_url || value.profile_url;

      if (url && /linkedin\.com\/in\//i.test(url)) {
        console.log(LOG_PREFIX, 'Found LinkedIn URL:', url,
          'confidence:', entity.confidence, 'entity:', entityId);
        return url.split('?')[0];
      }

      // Scan all string values in entity.
      for (const v of Object.values(value)) {
        if (typeof v !== 'string') continue;
        const match = v.match(
          /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i
        );
        if (match) {
          console.log(LOG_PREFIX, 'Found LinkedIn URL via scan:', match[0]);
          return match[0].split('?')[0];
        }
      }
    }
  }

  // Fallback: check if response is a flat array.
  if (Array.isArray(responseData)) {
    for (const row of responseData) {
      const url = row?.linkedin_profile_url || row?.linkedin_url;
      if (url && /linkedin\.com\/in\//i.test(url)) return url.split('?')[0];
    }
  }

  return null;
}

/**
 * Trigger enrichment and poll until results are ready.
 *
 * @param {Object} spec       Input/output schema spec.
 * @param {Array}  inputRows  Array of input objects.
 * @param {string} apiToken   Bright Data API bearer token.
 * @returns {Promise<{requestId: string, data: Array|null}>}
 */
async function triggerAndPoll(spec, inputRows, apiToken) {
  const body = { spec, input: inputRows };

  console.log(LOG_PREFIX, 'Triggering enrichment:', JSON.stringify(inputRows).slice(0, 200));

  // ── Step 1: Trigger ─────────────────────────────────────────────────────
  const triggerRes = await fetch(`${BASE_URL}/trigger_enrichment`, {
    method:  'POST',
    headers: authHeaders(apiToken),
    body:    JSON.stringify(body),
  });

  if (!triggerRes.ok) {
    const errBody = await triggerRes.text().catch(() => '');
    console.error(LOG_PREFIX, `trigger_enrichment HTTP ${triggerRes.status}:`, errBody.slice(0, 300));
    throw new Error(
      `Deep Lookup trigger_enrichment failed HTTP ${triggerRes.status}: ${errBody.slice(0, 200)}`
    );
  }

  const triggerData = await triggerRes.json();
  const requestId = triggerData?.request_id;

  if (!requestId) {
    console.error(LOG_PREFIX, 'No request_id in response:', JSON.stringify(triggerData).slice(0, 300));
    throw new Error(
      'Deep Lookup trigger_enrichment missing request_id: ' +
      JSON.stringify(triggerData).slice(0, 200)
    );
  }

  console.log(LOG_PREFIX, 'Enrichment queued:', requestId, 'status:', triggerData.status,
    'max_cost:', triggerData.max_cost);

  // ── Step 2: Poll status ─────────────────────────────────────────────────
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > DEEP_LOOKUP_TIMEOUT_MS) {
      throw new Error(`Deep Lookup ${requestId} timed out after ${DEEP_LOOKUP_TIMEOUT_MS / 1000}s`);
    }

    await sleep(POLL_INTERVAL_MS);

    console.log(
      LOG_PREFIX,
      `Polling request ${requestId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`
    );

    const statusRes = await fetch(`${BASE_URL}/request/${requestId}/status`, {
      method:  'GET',
      headers: authHeadersGet(apiToken),
    });

    if (!statusRes.ok) {
      console.warn(LOG_PREFIX, `Status poll HTTP ${statusRes.status}`);
      continue;
    }

    const statusData = await statusRes.json();
    const status = statusData?.status;

    console.log(LOG_PREFIX, `Request ${requestId} status: ${status}`);

    if (status === 'completed' || status === 'ready') {
      break;
    }

    if (status === 'failed' || status === 'error') {
      const errMsg = statusData?.error || 'unknown';
      console.error(LOG_PREFIX, `Request ${requestId} failed:`, errMsg);
      throw new Error(`Deep Lookup request ${requestId} failed: ${errMsg}`);
    }

    // queued / running / processing — keep polling.
    if (attempt === MAX_POLL_ATTEMPTS) {
      throw new Error(
        `Deep Lookup request ${requestId} not completed after ${MAX_POLL_ATTEMPTS} attempts`
      );
    }
  }

  // ── Step 3: Download results ────────────────────────────────────────────
  console.log(LOG_PREFIX, 'Downloading results for', requestId);

  const dataRes = await fetch(`${BASE_URL}/request/${requestId}`, {
    method:  'GET',
    headers: authHeadersGet(apiToken),
  });

  if (!dataRes.ok) {
    const errBody = await dataRes.text().catch(() => '');
    console.error(LOG_PREFIX, `Request download HTTP ${dataRes.status}:`, errBody.slice(0, 300));
    throw new Error(
      `Deep Lookup download failed HTTP ${dataRes.status}: ${errBody.slice(0, 200)}`
    );
  }

  const responseData = await dataRes.json();
  console.log(LOG_PREFIX, 'Results downloaded, status:', responseData?.status,
    'entities:', responseData?.data ? Object.keys(responseData.data).length : 0);

  return { requestId, responseData };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Use Deep Lookup trigger_enrichment to find a person's LinkedIn profile URL.
 * Fallback when SERP discovery fails.
 *
 * @param {string}      email     Person's email address.
 * @param {string|null} name      Full name (optional context).
 * @param {string|null} company   Company name (optional context).
 * @param {string}      apiToken  Bright Data API bearer token.
 * @returns {Promise<{linkedInUrl: string|null, data: Array|null}>}
 */
export async function deepLookupFindLinkedIn(email, name, company, apiToken) {
  const input = {};
  if (email) input.email = email;
  if (name)  input.full_name = name;
  if (company) input.company = company;

  if (!input.email && !input.full_name) {
    throw new Error('deepLookupFindLinkedIn: email or name is required');
  }

  const { requestId, responseData } = await triggerAndPoll(
    LINKEDIN_DISCOVERY_SPEC,
    [input],
    apiToken
  );

  const linkedInUrl = extractLinkedInUrl(responseData);

  console.log(LOG_PREFIX, `Discovery ${requestId} result: linkedInUrl=${linkedInUrl || 'none'}`);

  return { linkedInUrl, responseData };
}

/**
 * Use Deep Lookup trigger_enrichment to enrich a known LinkedIn profile.
 *
 * @param {string}      linkedInUrl  LinkedIn profile URL.
 * @param {string|null} linkedInId   LinkedIn profile ID/slug.
 * @param {string|null} name         Person's name.
 * @param {string}      apiToken     Bright Data API bearer token.
 * @returns {Promise<Object|null>}   Enriched data or null.
 */
export async function deepLookupEnrich(linkedInUrl, linkedInId, name, apiToken) {
  const input = {};
  if (linkedInUrl) input.linkedin_url = linkedInUrl;
  if (linkedInId) input.linkedin_id = linkedInId;
  if (name) input.full_name = name;

  try {
    const { responseData } = await triggerAndPoll(
      LINKEDIN_ENRICHMENT_SPEC,
      [input],
      apiToken
    );
    // Extract first entity value from the data block.
    const dataBlock = responseData?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock)[0];
      return dataBlock[firstKey]?.value || null;
    }
    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Deep Lookup enrich failed:', err.message);
    return null;
  }
}
