// PreMeet – Deep Lookup v1 (trigger_enrichment)
// Uses Bright Data's deep lookup API to find LinkedIn profiles and enrich data.

import type { DeepLookupSpec } from './types';

const LOG_PREFIX = '[PreMeet][DeepLookup]';

const BASE_URL = 'https://api.brightdata.com/datasets/deep_lookup/v1';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 30;
const DEEP_LOOKUP_TIMEOUT_MS = 120_000;

// ─── Spec Definitions ────────────────────────────────────────────────────────

const LINKEDIN_DISCOVERY_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Email address of the person to find on LinkedIn' },
      full_name: { type: 'string', description: 'Full name of the person' },
      company: { type: 'string', description: 'Current company or employer name' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      linkedin_profile_url: {
        type: 'string',
        description:
          "The full LinkedIn profile URL (https://linkedin.com/in/...) for the person. If unavailable, return 'LinkedIn profile not found.'",
      },
      full_name: { type: 'string', description: 'Full name as it appears on the LinkedIn profile.' },
      current_position: {
        type: 'string',
        description: "Current job title and company as listed on LinkedIn. If unavailable, return 'Position unavailable.'",
      },
      linkedin_id: {
        type: 'string',
        description: 'The LinkedIn profile slug/ID extracted from the profile URL (the part after /in/ in the URL). If unavailable, return empty string.',
      },
    },
  },
};

const LINKEDIN_ENRICHMENT_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      linkedin_url: { type: 'string', description: 'LinkedIn profile URL to enrich' },
      linkedin_id: { type: 'string', description: 'LinkedIn profile slug/ID' },
      full_name: { type: 'string', description: 'Full name of the person' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      current_position: { type: 'string', description: 'Current job title and company.' },
      work_experience: {
        type: 'string',
        description: 'A summary of the most recent 3-5 work positions including company name, title, and dates. If unavailable, return empty string.',
      },
      education: {
        type: 'string',
        description: 'Education background including institution names and degrees. If unavailable, return empty string.',
      },
      skills: { type: 'string', description: 'Comma-separated list of key professional skills.' },
    },
  },
};

const COMPANY_INTELLIGENCE_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      full_name: { type: 'string', description: 'Full name of the person' },
      company_name: { type: 'string', description: 'Name of the company the person works at' },
      job_title: { type: 'string', description: 'Current job title of the person' },
      linkedin_url: { type: 'string', description: 'LinkedIn profile URL of the person' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      company_description: {
        type: 'string',
        description: "A 2-3 sentence description of what the company does. If unavailable, return ''.",
      },
      company_industry: {
        type: 'string',
        description: "The company's primary industry or sector. If unavailable, return ''.",
      },
      company_website: {
        type: 'string',
        description: "The company's main website URL. If unavailable, return ''.",
      },
      company_founded_year: {
        type: 'string',
        description: "Year the company was founded. If unavailable, return ''.",
      },
      company_headquarters: {
        type: 'string',
        description: "City and country of company HQ. If unavailable, return ''.",
      },
      company_funding: {
        type: 'string',
        description: "Total funding raised or last funding round details. If unavailable, return ''.",
      },
      products_services: {
        type: 'string',
        description: "Comma-separated list of the main products or services. If unavailable, return ''.",
      },
      technologies: {
        type: 'string',
        description: "Comma-separated list of key technologies. If unavailable, return ''.",
      },
      recent_news: {
        type: 'string',
        description: "One or two recent news headlines. If unavailable, return ''.",
      },
    },
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
}

function authHeadersGet(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLinkedInUrl(responseData: unknown): string | null {
  const dataBlock = (responseData as Record<string, unknown>)?.data;
  if (dataBlock && typeof dataBlock === 'object') {
    for (const entityId of Object.keys(dataBlock as Record<string, unknown>)) {
      const entity = (dataBlock as Record<string, Record<string, unknown>>)[entityId];
      const value = entity?.value;
      if (!value || typeof value !== 'object') continue;

      const v = value as Record<string, unknown>;
      const url = String(v.linkedin_profile_url || v.linkedin_url || v.profile_url || '');
      if (url && /(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) {
        console.log(LOG_PREFIX, 'Found LinkedIn URL:', url, 'confidence:', entity.confidence, 'entity:', entityId);
        return url.split('?')[0];
      }

      for (const val of Object.values(v)) {
        if (typeof val !== 'string') continue;
        const match = val.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+/i);
        if (match) {
          console.log(LOG_PREFIX, 'Found LinkedIn URL via scan:', match[0]);
          return match[0].split('?')[0];
        }
      }
    }
  }

  if (Array.isArray(responseData)) {
    for (const row of responseData) {
      const url = row?.linkedin_profile_url || row?.linkedin_url;
      if (url && /(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(url)) return url.split('?')[0];
    }
  }

  return null;
}

async function triggerAndPoll(
  spec: DeepLookupSpec,
  inputRows: Record<string, unknown>[],
  apiToken: string,
): Promise<{ requestId: string; responseData: unknown }> {
  const body = { spec, input: inputRows };

  console.log(LOG_PREFIX, 'Triggering enrichment:', JSON.stringify(inputRows).slice(0, 200));

  const triggerRes = await fetch(`${BASE_URL}/trigger_enrichment`, {
    method: 'POST',
    headers: authHeaders(apiToken),
    body: JSON.stringify(body),
  });

  if (!triggerRes.ok) {
    const errBody = await triggerRes.text().catch(() => '');
    console.error(LOG_PREFIX, `trigger_enrichment HTTP ${triggerRes.status}:`, errBody.slice(0, 300));
    throw new Error(`Enrichment trigger failed HTTP ${triggerRes.status}: ${errBody.slice(0, 200)}`);
  }

  const triggerData = await triggerRes.json();
  const requestId = triggerData?.request_id;

  if (!requestId) {
    console.error(LOG_PREFIX, 'No request_id in response:', JSON.stringify(triggerData).slice(0, 300));
    throw new Error('Enrichment trigger missing request_id: ' + JSON.stringify(triggerData).slice(0, 200));
  }

  console.log(LOG_PREFIX, 'Enrichment queued:', requestId, 'status:', triggerData.status, 'max_cost:', triggerData.max_cost);

  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() - startedAt > DEEP_LOOKUP_TIMEOUT_MS) {
      throw new Error(`Enrichment request ${requestId} timed out after ${DEEP_LOOKUP_TIMEOUT_MS / 1000}s`);
    }

    await sleep(POLL_INTERVAL_MS);
    console.log(LOG_PREFIX, `Polling request ${requestId} (attempt ${attempt}/${MAX_POLL_ATTEMPTS})`);

    const statusRes = await fetch(`${BASE_URL}/request/${requestId}/status`, {
      method: 'GET',
      headers: authHeadersGet(apiToken),
    });

    if (!statusRes.ok) {
      console.warn(LOG_PREFIX, `Status poll HTTP ${statusRes.status}`);
      continue;
    }

    const statusData = await statusRes.json();
    const status = statusData?.status;

    console.log(LOG_PREFIX, `Request ${requestId} status: ${status}`);

    if (status === 'completed' || status === 'ready') break;

    if (status === 'failed' || status === 'error') {
      const errMsg = statusData?.error || 'unknown';
      console.error(LOG_PREFIX, `Request ${requestId} failed:`, errMsg);
      throw new Error(`Enrichment request ${requestId} failed: ${errMsg}`);
    }

    if (attempt === MAX_POLL_ATTEMPTS) {
      throw new Error(`Enrichment request ${requestId} not completed after ${MAX_POLL_ATTEMPTS} attempts`);
    }
  }

  console.log(LOG_PREFIX, 'Downloading results for', requestId);

  const dataRes = await fetch(`${BASE_URL}/request/${requestId}`, {
    method: 'GET',
    headers: authHeadersGet(apiToken),
  });

  if (!dataRes.ok) {
    const errBody = await dataRes.text().catch(() => '');
    console.error(LOG_PREFIX, `Request download HTTP ${dataRes.status}:`, errBody.slice(0, 300));
    throw new Error(`Enrichment download failed HTTP ${dataRes.status}: ${errBody.slice(0, 200)}`);
  }

  const responseData = await dataRes.json();
  console.log(
    LOG_PREFIX,
    'Results downloaded, status:',
    responseData?.status,
    'entities:',
    responseData?.data ? Object.keys(responseData.data).length : 0,
  );

  return { requestId, responseData };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function deepLookupFindLinkedIn(
  email: string,
  name: string | null,
  company: string | null,
  apiToken: string,
): Promise<{ linkedInUrl: string | null; responseData: unknown }> {
  if (!email || !email.includes('@')) {
    console.warn(LOG_PREFIX, 'Skipping: email is required but missing');
    return { linkedInUrl: null, responseData: null };
  }

  let fullName = name;
  if (!fullName && email) {
    fullName = email.split('@')[0].replace(/[._\-+]/g, ' ').trim();
  }

  const input = {
    email,
    full_name: fullName || 'Unknown',
    company: company || 'Unknown',
  };

  const { requestId, responseData } = await triggerAndPoll(LINKEDIN_DISCOVERY_SPEC, [input], apiToken);

  const linkedInUrl = extractLinkedInUrl(responseData);
  console.log(LOG_PREFIX, `Discovery ${requestId} result: linkedInUrl=${linkedInUrl || 'none'}`);

  return { linkedInUrl, responseData };
}

export async function deepLookupEnrich(
  linkedInUrl: string,
  linkedInId: string | null,
  name: string | null,
  apiToken: string,
): Promise<Record<string, unknown> | null> {
  const input: Record<string, string> = {};
  if (linkedInUrl) input.linkedin_url = linkedInUrl;
  if (linkedInId) input.linkedin_id = linkedInId;
  if (name) input.full_name = name;

  try {
    const { responseData } = await triggerAndPoll(LINKEDIN_ENRICHMENT_SPEC, [input], apiToken);
    const dataBlock = (responseData as Record<string, unknown>)?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock as Record<string, unknown>)[0];
      return ((dataBlock as Record<string, Record<string, unknown>>)[firstKey]?.value as Record<string, unknown>) || null;
    }
    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Enrich failed:', (err as Error).message);
    return null;
  }
}

export async function deepLookupCompanyIntel(
  companyName: string,
  personName: string | null,
  jobTitle: string | null,
  linkedInUrl: string | null,
  apiToken: string,
): Promise<Record<string, unknown> | null> {
  if (!companyName) {
    console.warn(LOG_PREFIX, 'Skipping company intel: no company name');
    return null;
  }

  const input = {
    company_name: companyName,
    full_name: personName || 'Unknown',
    job_title: jobTitle || 'Unknown',
    linkedin_url: linkedInUrl || 'Unknown',
  };

  try {
    console.log(LOG_PREFIX, 'Company intel lookup for:', companyName);
    const { responseData } = await triggerAndPoll(COMPANY_INTELLIGENCE_SPEC, [input], apiToken);

    const dataBlock = (responseData as Record<string, unknown>)?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock as Record<string, unknown>)[0];
      const value = (dataBlock as Record<string, Record<string, unknown>>)[firstKey]?.value;
      if (value) {
        console.log(LOG_PREFIX, 'Company intel result:', Object.keys(value as Record<string, unknown>).join(', '));
        return value as Record<string, unknown>;
      }
    }

    if (Array.isArray(responseData) && responseData.length > 0) {
      return responseData[0] as Record<string, unknown>;
    }

    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, 'Company intel lookup failed:', (err as Error).message);
    return null;
  }
}

export async function deepLookupCustomEnrich(
  linkedinUrl: string | null,
  linkedinId: string | null,
  name: string | null,
  company: string | null,
  enrichType: 'experience' | 'education' | 'skills' | 'company',
  apiToken: string,
): Promise<Record<string, unknown> | null> {
  const CUSTOM_ENRICH_SPECS: Record<string, DeepLookupSpec> = {
    experience: {
      input_schema: {
        type: 'object',
        properties: {
          linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
          linkedin_id: { type: 'string', description: 'LinkedIn profile slug/ID' },
          full_name: { type: 'string', description: 'Full name of the person' },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          positions: {
            type: 'string',
            description:
              'Complete work history as a JSON array of objects, each with: "title", "company", "start_date", "end_date", "description". Return valid JSON array string.',
          },
        },
      },
    },
    education: {
      input_schema: {
        type: 'object',
        properties: {
          linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
          linkedin_id: { type: 'string', description: 'LinkedIn profile slug/ID' },
          full_name: { type: 'string', description: 'Full name of the person' },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          education_entries: {
            type: 'string',
            description:
              'Complete education history as a JSON array of objects, each with: "school", "degree", "field", "start_year", "end_year". Return valid JSON array string.',
          },
        },
      },
    },
    skills: {
      input_schema: {
        type: 'object',
        properties: {
          linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
          linkedin_id: { type: 'string', description: 'LinkedIn profile slug/ID' },
          full_name: { type: 'string', description: 'Full name of the person' },
        },
      },
      output_schema: {
        type: 'object',
        properties: {
          skills_list: {
            type: 'string',
            description:
              'All professional skills as a JSON array of objects, each with: "name", "category". Return valid JSON array string.',
          },
        },
      },
    },
    company: COMPANY_INTELLIGENCE_SPEC,
  };

  const spec = CUSTOM_ENRICH_SPECS[enrichType];
  if (!spec) {
    console.warn(LOG_PREFIX, 'Unknown enrich type:', enrichType);
    return null;
  }

  const input: Record<string, string> = {};
  if (enrichType === 'company') {
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

    const dataBlock = (responseData as Record<string, unknown>)?.data;
    if (dataBlock && typeof dataBlock === 'object') {
      const firstKey = Object.keys(dataBlock as Record<string, unknown>)[0];
      const value = (dataBlock as Record<string, Record<string, unknown>>)[firstKey]?.value;
      if (value) {
        console.log(LOG_PREFIX, `Custom enrich [${enrichType}] result:`, Object.keys(value as Record<string, unknown>).join(', '));
        return { enrichType, ...(value as Record<string, unknown>) };
      }
    }

    if (Array.isArray(responseData) && responseData.length > 0) {
      return { enrichType, ...(responseData[0] as Record<string, unknown>) };
    }

    return null;
  } catch (err) {
    console.warn(LOG_PREFIX, `Custom enrich [${enrichType}] failed:`, (err as Error).message);
    return null;
  }
}
