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

/**
 * Inline spec for company intelligence and public web enrichment.
 * Searches the public web for company details, products, and news
 * to complement LinkedIn profile data.
 */
const COMPANY_INTELLIGENCE_SPEC = {
  input_schema: {
    type: 'object',
    properties: {
      full_name: {
        type: 'string',
        description: 'Full name of the person',
      },
      company_name: {
        type: 'string',
        description: 'Name of the company the person works at',
      },
      job_title: {
        type: 'string',
        description: 'Current job title of the person',
      },
      linkedin_url: {
        type: 'string',
        description: 'LinkedIn profile URL of the person',
      },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      company_description: {
        type: 'string',
        description:
          'A 2-3 sentence description of what the company does, its main products or services, ' +
          "and its value proposition. If unavailable, return ''.",
      },
      company_industry: {
        type: 'string',
        description:
          "The company's primary industry or sector (e.g. 'SaaS', 'FinTech', 'Healthcare'). " +
          "If unavailable, return ''.",
      },
      company_website: {
        type: 'string',
        description: "The company's main website URL. If unavailable, return ''.",
      },
      company_founded_year: {
        type: 'string',
        description: "Year the company was founded (e.g. '2015'). If unavailable, return ''.",
      },
      company_headquarters: {
        type: 'string',
        description: "City and country of company HQ (e.g. 'San Francisco, US'). If unavailable, return ''.",
      },
      company_funding: {
        type: 'string',
        description:
          "Total funding raised or last funding round details (e.g. 'Series B, $50M'). " +
          "If unavailable, return ''.",
      },
      products_services: {
        type: 'string',
        description:
          'Comma-separated list of the main products or services the company offers. ' +
          "If unavailable, return ''.",
      },
      technologies: {
        type: 'string',
        description:
          'Comma-separated list of key technologies, platforms, or tools the company uses or builds. ' +
          "If unavailable, return ''.",
      },
      recent_news: {
        type: 'string',
        description:
          'One or two recent news headlines or notable achievements about the company or this person. ' +
          "If unavailable, return ''.",
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

      if (url && /(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) {
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
      if (url && /(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) return url.split('?')[0];
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
  // The trigger_enrichment API requires email in the input — without it
  // the request returns 400: "[0].email" is required.
  if (!email || !email.includes('@')) {
    console.warn(LOG_PREFIX, 'Skipping Deep Lookup: email is required but missing');
    return { linkedInUrl: null, responseData: null };
  }

  // API rejects empty strings for full_name — derive from email if needed
  let fullName = name;
  if (!fullName && email) {
    fullName = email.split('@')[0].replace(/[._\-+]/g, ' ').trim();
  }

  const input = {
    email,
    full_name: fullName || 'Unknown',
    company:   company || 'Unknown',
  };

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

// ─── Custom Enrichment Specs (per enrichType) ────────────────────────────────

const CUSTOM_ENRICH_SPECS = {
  experience: {
    input_schema: {
      type: 'object',
      properties: {
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        linkedin_id:  { type: 'string', description: 'LinkedIn profile slug/ID' },
        full_name:    { type: 'string', description: 'Full name of the person' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        positions: {
          type: 'string',
          description:
            'Complete work history as a JSON array of objects, each with: ' +
            '"title" (job title), "company" (company name), "start_date" (e.g. "Jan 2020"), ' +
            '"end_date" (e.g. "Present" or "Dec 2023"), "description" (1-2 sentence summary of role). ' +
            'Include ALL positions, not just recent ones. Return valid JSON array string.',
        },
      },
    },
  },
  education: {
    input_schema: {
      type: 'object',
      properties: {
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        linkedin_id:  { type: 'string', description: 'LinkedIn profile slug/ID' },
        full_name:    { type: 'string', description: 'Full name of the person' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        education_entries: {
          type: 'string',
          description:
            'Complete education history as a JSON array of objects, each with: ' +
            '"school" (institution name), "degree" (e.g. "B.Sc.", "MBA"), ' +
            '"field" (field of study), "start_year" (e.g. "2010"), "end_year" (e.g. "2014"). ' +
            'Return valid JSON array string.',
        },
      },
    },
  },
  skills: {
    input_schema: {
      type: 'object',
      properties: {
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        linkedin_id:  { type: 'string', description: 'LinkedIn profile slug/ID' },
        full_name:    { type: 'string', description: 'Full name of the person' },
      },
    },
    output_schema: {
      type: 'object',
      properties: {
        skills_list: {
          type: 'string',
          description:
            'All professional skills as a JSON array of objects, each with: ' +
            '"name" (skill name), "category" (e.g. "Technical", "Management", "Industry Knowledge"). ' +
            'Return valid JSON array string.',
        },
      },
    },
  },
  company: COMPANY_INTELLIGENCE_SPEC,
};

/**
 * Use Deep Lookup trigger_enrichment with a custom schema
 * for user-initiated enrichment requests.
 *
 * @param {string}      linkedinUrl  LinkedIn profile URL.
 * @param {string|null} linkedinId   LinkedIn profile ID/slug.
 * @param {string|null} name         Person's name.
 * @param {string|null} company      Company name (used for company enrichType).
 * @param {string}      enrichType   One of: 'experience', 'education', 'skills', 'company'.
 * @param {string}      apiToken     Bright Data API bearer token.
 * @returns {Promise<Object|null>}   Enriched data or null.
 */
export async function deepLookupCustomEnrich(linkedinUrl, linkedinId, name, company, enrichType, apiToken) {
  const spec = CUSTOM_ENRICH_SPECS[enrichType];
  if (!spec) {
    console.warn(LOG_PREFIX, 'Unknown enrich type:', enrichType);
    return null;
  }

  const input = {};
  if (enrichType === 'company') {
    // Company intel uses different input fields
    input.full_name = name || 'Unknown';
    input.company_name = company || 'Unknown';
    input.job_title = 'Unknown';
    if (linkedinUrl) input.linkedin_url = linkedinUrl;
  } else {
    if (linkedinUrl) input.linkedin_url = linkedinUrl;
    if (linkedinId) input.linkedin_id = linkedinId;
    if (name) input.full_name = name;
  }

  console.log(LOG_PREFIX, `Custom enrich [${enrichType}] for:`, name || linkedinUrl);

  try {
    const { responseData } = await triggerAndPoll(spec, [input], apiToken);

    const dataBlock = responseData?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock)[0];
      const value = dataBlock[firstKey]?.value;
      if (value) {
        console.log(LOG_PREFIX, `Custom enrich [${enrichType}] result:`, Object.keys(value).join(', '));
        return { enrichType, ...value };
      }
    }

    if (Array.isArray(responseData) && responseData.length > 0) {
      return { enrichType, ...responseData[0] };
    }

    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, `Custom enrich [${enrichType}] failed:`, err.message);
    return null;
  }
}

/**
 * Use Deep Lookup trigger_enrichment to gather company intelligence
 * and public web data about a person and their company.
 *
 * Runs after the LinkedIn profile is known — searches the public web
 * for company details, products/services, funding, and news.
 *
 * @param {string}      companyName  Company name.
 * @param {string|null} personName   Person's full name.
 * @param {string|null} jobTitle     Current job title.
 * @param {string|null} linkedInUrl  LinkedIn profile URL.
 * @param {string}      apiToken     Bright Data API bearer token.
 * @returns {Promise<Object|null>}   Company intelligence data or null.
 */
export async function deepLookupCompanyIntel(companyName, personName, jobTitle, linkedInUrl, apiToken) {
  if (!companyName) {
    console.warn(LOG_PREFIX, 'Skipping company intel: no company name');
    return null;
  }

  // API rejects empty strings — use 'Unknown' as placeholder
  const input = {
    company_name: companyName,
    full_name:    personName || 'Unknown',
    job_title:    jobTitle || 'Unknown',
    linkedin_url: linkedInUrl || 'Unknown',
  };

  try {
    console.log(LOG_PREFIX, 'Company intel lookup for:', companyName);
    const { responseData } = await triggerAndPoll(
      COMPANY_INTELLIGENCE_SPEC,
      [input],
      apiToken
    );

    // Extract first entity value from the nested data block.
    const dataBlock = responseData?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock)[0];
      const value = dataBlock[firstKey]?.value;
      if (value) {
        console.log(LOG_PREFIX, 'Company intel result:', Object.keys(value).join(', '));
        return value;
      }
    }

    // Fallback: flat array response.
    if (Array.isArray(responseData) && responseData.length > 0) {
      return responseData[0];
    }

    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Company intel lookup failed:', err.message);
    return null;
  }
}
