// PreMeet — BrightData SERP API Client
// Sync Google search via zone=serp to discover LinkedIn URLs/IDs.
//
// Endpoint: POST https://api.brightdata.com/request
// Latency: ~2-3s (benchmarked)
// Returns parsed organic results with titles, links, descriptions.

const BRIGHTDATA_BASE = 'https://api.brightdata.com/request';

export interface SerpResult {
  title: string;
  link: string;
  description: string;
  position: number;
}

export interface SerpResponse {
  results: SerpResult[];
  linkedinUrl: string | null;
  linkedinId: string | null;
  companyLinkedinUrl: string | null;
  companyLinkedinId: string | null;
  latencyMs: number;
  error: string | null;
}

/**
 * Run a SERP query to discover a person's LinkedIn URL from name + email.
 */
export async function serpDiscoverPerson(
  fullName: string,
  email: string,
  company: string | null,
  apiKey: string,
): Promise<SerpResponse> {
  const emailDomain = email.split('@')[1] || '';
  const companyPart = company ? `"${company}"` : `"${emailDomain}"`;
  const query = `("${fullName}" AND "${email}") (site:linkedin.com/in OR site:crunchbase.com OR site:rocketreach.co OR site:zoominfo.com OR site:apollo.io)`;

  return serpQuery(query, apiKey);
}

/**
 * Run a SERP query to discover a company's LinkedIn URL.
 */
export async function serpDiscoverCompany(
  companyName: string,
  apiKey: string,
): Promise<SerpResponse> {
  const query = `${companyName} site:linkedin.com/company`;
  return serpQuery(query, apiKey);
}

async function serpQuery(query: string, apiKey: string): Promise<SerpResponse> {
  const start = performance.now();

  try {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(BRIGHTDATA_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: 'serp',
        url,
        format: 'json',
        data_format: 'parsed_light',
      }),
    });

    if (!resp.ok) {
      return {
        results: [],
        linkedinUrl: null,
        linkedinId: null,
        companyLinkedinUrl: null,
        companyLinkedinId: null,
        latencyMs: elapsed(start),
        error: `SERP HTTP ${resp.status}`,
      };
    }

    // SERP returns { status_code, headers, body } where body is a JSON string
    const wrapper = await resp.json();
    const body = typeof wrapper.body === 'string' ? JSON.parse(wrapper.body) : wrapper.body || wrapper;
    const organic: Array<Record<string, unknown>> = body.organic || [];

    const results: SerpResult[] = organic.map((r, i) => ({
      title: String(r.title || ''),
      link: String(r.link || ''),
      description: String(r.description || ''),
      position: i + 1,
    }));

    // Extract LinkedIn person URL/ID
    let linkedinUrl: string | null = null;
    let linkedinId: string | null = null;
    for (const r of results) {
      const match = r.link.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
      if (match) {
        linkedinUrl = r.link;
        linkedinId = decodeURIComponent(match[1]).replace(/\/+$/, '');
        break;
      }
    }

    // Extract LinkedIn company URL/ID
    let companyLinkedinUrl: string | null = null;
    let companyLinkedinId: string | null = null;
    for (const r of results) {
      const match = r.link.match(/linkedin\.com\/company\/([a-zA-Z0-9\-_%]+)/i);
      if (match) {
        companyLinkedinUrl = r.link;
        companyLinkedinId = decodeURIComponent(match[1]).replace(/\/+$/, '').split('?')[0];
        break;
      }
    }

    return {
      results,
      linkedinUrl,
      linkedinId,
      companyLinkedinUrl,
      companyLinkedinId,
      latencyMs: elapsed(start),
      error: null,
    };
  } catch (err) {
    return {
      results: [],
      linkedinUrl: null,
      linkedinId: null,
      companyLinkedinUrl: null,
      companyLinkedinId: null,
      latencyMs: elapsed(start),
      error: `SERP error: ${(err as Error).message}`,
    };
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
