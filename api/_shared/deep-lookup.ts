// PreMeet — Deep Lookup API Client for Edge Functions
// Wraps BrightData's Deep Lookup trigger_enrichment endpoint.
// Async: trigger → poll status → download results.

import { fetchWithRetry } from './fetch-retry';

const BASE_URL = 'https://api.brightdata.com/datasets/deep_lookup/v1';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 30; // ~90s
const DEFAULT_TIMEOUT_MS = 120_000;

export interface DeepLookupResult {
  data: Record<string, unknown> | null;
  error: string | null;
  latencyMs: number;
  requestId: string | null;
}

interface DeepLookupSpec {
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
  };
  output_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
  };
}

// ── Pre-built Specs ─────────────────────────────────────────────────────────

export const COMPANY_LOOKUP_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      company_name: { type: 'string', description: 'Company name to look up' },
      website: { type: 'string', description: 'Company website URL (optional)' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      company_name: { type: 'string', description: 'Official company name' },
      industry: { type: 'string', description: 'Industry or sector' },
      description: { type: 'string', description: 'Company description' },
      website: { type: 'string', description: 'Company website' },
      employee_count: { type: 'string', description: 'Approximate number of employees' },
      headquarters: { type: 'string', description: 'HQ location' },
      linkedin_url: { type: 'string', description: 'LinkedIn company page URL' },
      founded_year: { type: 'string', description: 'Year the company was founded' },
      revenue_range: { type: 'string', description: 'Estimated annual revenue range' },
    },
  },
};

export const PERSON_LOOKUP_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      full_name: { type: 'string', description: 'Full name of the person' },
      email: { type: 'string', description: 'Email address (optional)' },
      company: { type: 'string', description: 'Current company (optional)' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      linkedin_profile_url: { type: 'string', description: 'LinkedIn profile URL' },
      full_name: { type: 'string', description: 'Full name as found' },
      current_position: { type: 'string', description: 'Current job title and company' },
      email: { type: 'string', description: 'Email address if found' },
      phone: { type: 'string', description: 'Phone number if found' },
      location: { type: 'string', description: 'Location' },
    },
  },
};

export const CONTACT_LOOKUP_SPEC: DeepLookupSpec = {
  input_schema: {
    type: 'object',
    properties: {
      linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
      full_name: { type: 'string', description: 'Full name of the person' },
    },
  },
  output_schema: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'Professional or personal email address' },
      phone: { type: 'string', description: 'Phone number' },
      twitter: { type: 'string', description: 'Twitter/X handle or URL' },
      github: { type: 'string', description: 'GitHub profile URL' },
    },
  },
};

// ── Client ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deepLookup(
  spec: DeepLookupSpec,
  input: Record<string, string>,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DeepLookupResult> {
  const start = performance.now();

  try {
    // Step 1: Trigger enrichment
    const triggerResp = await fetchWithRetry(
      `${BASE_URL}/trigger_enrichment`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ spec, input: [input] }),
      },
      'deep-lookup',
    );

    if (!triggerResp.ok) {
      const errText = await triggerResp.text().catch(() => '');
      return {
        data: null,
        error: `Trigger failed: HTTP ${triggerResp.status} ${errText.slice(0, 200)}`,
        latencyMs: elapsed(start),
        requestId: null,
      };
    }

    const triggerData = await triggerResp.json();
    const requestId = triggerData?.request_id;

    if (!requestId) {
      return {
        data: null,
        error: 'No request_id returned',
        latencyMs: elapsed(start),
        requestId: null,
      };
    }

    // Step 2: Poll for completion
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
      if (performance.now() - start > timeoutMs) {
        return {
          data: null,
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
          latencyMs: elapsed(start),
          requestId,
        };
      }

      await sleep(POLL_INTERVAL_MS);

      const statusResp = await fetch(`${BASE_URL}/request/${requestId}/status`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!statusResp.ok) continue;

      const statusData = await statusResp.json();

      if (statusData.status === 'completed') {
        // Step 3: Download results
        const resultResp = await fetch(`${BASE_URL}/request/${requestId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!resultResp.ok) {
          return {
            data: null,
            error: `Result download failed: HTTP ${resultResp.status}`,
            latencyMs: elapsed(start),
            requestId,
          };
        }

        const resultData = await resultResp.json();

        // Extract the enriched value from the response
        const enrichedData = extractDeepLookupData(resultData);

        return {
          data: enrichedData,
          error: null,
          latencyMs: elapsed(start),
          requestId,
        };
      }

      if (statusData.status === 'failed') {
        return {
          data: null,
          error: `Deep Lookup failed: ${statusData.error || 'unknown'}`,
          latencyMs: elapsed(start),
          requestId,
        };
      }
    }

    return {
      data: null,
      error: `Max poll attempts (${MAX_POLL_ATTEMPTS}) reached`,
      latencyMs: elapsed(start),
      requestId,
    };
  } catch (err) {
    return {
      data: null,
      error: `Deep Lookup error: ${(err as Error).message}`,
      latencyMs: elapsed(start),
      requestId: null,
    };
  }
}

function extractDeepLookupData(response: Record<string, unknown>): Record<string, unknown> | null {
  const data = response.data as Record<string, Record<string, unknown>> | undefined;
  if (!data) return null;

  // Deep Lookup wraps results by entity_id
  for (const entityId of Object.keys(data)) {
    const entity = data[entityId];
    if (entity?.value && typeof entity.value === 'object') {
      return {
        ...(entity.value as Record<string, unknown>),
        _confidence: entity.confidence || null,
        _citations: entity.citations || null,
        _reasoning: entity.reasoning || null,
      };
    }
  }

  return null;
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
