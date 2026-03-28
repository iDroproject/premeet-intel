// PreMeet — MCP Tool Aggregator
// Orchestrates parallel Crunchbase + ZoomInfo MCP calls via BrightData SSE endpoint
// and merges normalized results into a single CompanyIntel object.

import { sql } from '../_shared/db.ts';
import { fetchWithRetry } from '../_shared/fetch-retry.ts';
import { normalizeCrunchbase } from './normalizers/crunchbase.ts';
import { normalizeZoominfo } from './normalizers/zoominfo.ts';
import type { CompanyIntel, McpToolResult } from './types.ts';

const MCP_BASE_URL = 'https://mcp.brightdata.com';
const CRUNCHBASE_TOOL = 'web_data_crunchbase_company';
const ZOOMINFO_TOOL = 'web_data_zoominfo_company_profile';

const CACHE_TTL: Record<string, number> = {
  crunchbase: 30 * 24 * 60 * 60, // 30 days in seconds
  zoominfo: 14 * 24 * 60 * 60,   // 14 days in seconds
};

interface SourceResult {
  data: Partial<CompanyIntel>;
  cached: boolean;
  success: boolean;
}

// ── MCP Tool Invocation ─────────────────────────────────────────────────────

// NOTE: BrightData's MCP SSE endpoint requires the token as a URL query parameter.
// This is a vendor constraint. The key is only used server-side and never exposed
// to clients. Ensure server logs do not capture full request URLs.

async function invokeMcpTool(
  toolName: string,
  params: Record<string, unknown>,
  mcpApiKey: string,
): Promise<McpToolResult> {
  const start = performance.now();
  const url = `${MCP_BASE_URL}/sse?token=${encodeURIComponent(mcpApiKey)}&tools=${toolName}`;

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
      `mcp:${toolName}`,
    );

    const latencyMs = Math.round(performance.now() - start);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        toolName,
        data: null,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
        latencyMs,
      };
    }

    const body = await response.json();

    // BrightData MCP returns array or single object
    const results = Array.isArray(body) ? body : [body];
    const valid = results.filter(
      (r: Record<string, unknown>) => !r.error && !r.error_code,
    );

    if (valid.length === 0) {
      return {
        toolName,
        data: null,
        error: 'No valid results returned',
        latencyMs,
      };
    }

    return {
      toolName,
      data: valid[0] as Record<string, unknown>,
      error: null,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      toolName,
      data: null,
      error: (err as Error).message,
      latencyMs,
    };
  }
}

// ── Cache Helpers ───────────────────────────────────────────────────────────

function cacheKey(source: string, companyName: string): string {
  return `${source}:company:${companyName.toLowerCase().trim()}`;
}

async function getCached(
  source: string,
  companyName: string,
): Promise<{ data: Record<string, unknown>; fetchedAt: string } | null> {
  const key = cacheKey(source, companyName);
  const rows = await sql`
    SELECT enrichment_data, fetched_at
    FROM enrichment_cache
    WHERE entity_type = 'company'
      AND entity_key = ${key}
      AND expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return { data: rows[0].enrichment_data, fetchedAt: rows[0].fetched_at };
}

async function putCache(
  source: string,
  companyName: string,
  data: Record<string, unknown>,
): Promise<void> {
  const key = cacheKey(source, companyName);
  const ttlSec = CACHE_TTL[source] ?? CACHE_TTL.crunchbase;
  const json = JSON.stringify(data);

  await sql`
    INSERT INTO enrichment_cache (entity_type, entity_key, enrichment_data, source, expires_at)
    VALUES ('company', ${key}, ${json}::jsonb, ${source}, now() + make_interval(secs => ${ttlSec}))
    ON CONFLICT (entity_type, entity_key)
    DO UPDATE SET
      enrichment_data = ${json}::jsonb,
      source = ${source},
      fetched_at = now(),
      expires_at = now() + make_interval(secs => ${ttlSec})
  `;

  // Update cache stats (miss → we fetched fresh data)
  sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 0, 1)`.catch(() => {});
}

// ── MCP Cost Tracking ───────────────────────────────────────────────────────

async function logMcpCall(
  userId: string,
  companyName: string,
  result: McpToolResult,
  cacheHit: boolean,
): Promise<void> {
  const entityKey = cacheKey(
    result.toolName === CRUNCHBASE_TOOL ? 'crunchbase' : 'zoominfo',
    companyName,
  );
  const status = cacheHit ? 'cached' : result.error ? 'failed' : 'success';

  await sql`
    INSERT INTO enrichment_requests (
      user_id, entity_type, entity_key, credits_used, status, cache_hit,
      tool_name, latency_ms, completed_at
    )
    VALUES (
      ${userId}, 'company', ${entityKey}, 0, ${status}, ${cacheHit},
      ${result.toolName}, ${result.latencyMs}, now()
    )
  `;
}

// ── Aggregator ──────────────────────────────────────────────────────────────

export async function aggregateCompanyIntel(
  companyName: string,
  companyDomain: string | undefined,
  userId: string,
  mcpApiKey: string,
): Promise<{
  intel: CompanyIntel;
  sources: {
    crunchbase: { success: boolean; cached: boolean };
    zoominfo: { success: boolean; cached: boolean };
  };
  anyCached: boolean;
}> {
  // Run Crunchbase + ZoomInfo in parallel, each checking cache first
  const [crunchbaseResult, zoominfoResult] = await Promise.all([
    fetchSource('crunchbase', CRUNCHBASE_TOOL, companyName, companyDomain, userId, mcpApiKey),
    fetchSource('zoominfo', ZOOMINFO_TOOL, companyName, companyDomain, userId, mcpApiKey),
  ]);

  // Merge partial results into a single CompanyIntel
  const intel: CompanyIntel = {
    // Crunchbase defaults
    crunchbaseUrl: null,
    totalFunding: null,
    lastFundingRound: null,
    investors: [],
    ipoStatus: null,
    acquisitions: null,
    // ZoomInfo defaults
    employeeCount: null,
    employeeGrowth6m: null,
    techStack: [],
    intentTopics: [],
    departmentBreakdown: null,
    // Override with actual data
    ...crunchbaseResult.data,
    ...zoominfoResult.data,
  };

  return {
    intel,
    sources: {
      crunchbase: { success: crunchbaseResult.success, cached: crunchbaseResult.cached },
      zoominfo: { success: zoominfoResult.success, cached: zoominfoResult.cached },
    },
    anyCached: crunchbaseResult.cached || zoominfoResult.cached,
  };
}

async function fetchSource(
  source: string,
  toolName: string,
  companyName: string,
  companyDomain: string | undefined,
  userId: string,
  mcpApiKey: string,
): Promise<SourceResult> {
  // Check cache first
  const cached = await getCached(source, companyName);
  if (cached) {
    // Log cache hit
    const cacheResult: McpToolResult = { toolName, data: cached.data, error: null, latencyMs: 0 };
    logMcpCall(userId, companyName, cacheResult, true).catch(() => {});
    sql`SELECT upsert_cache_stat(CURRENT_DATE, 'company', 1, 0)`.catch(() => {});

    const normalize = source === 'crunchbase' ? normalizeCrunchbase : normalizeZoominfo;
    return { data: normalize(cached.data), cached: true, success: true };
  }

  // Build MCP params
  const params: Record<string, unknown> = { company_name: companyName };
  if (companyDomain) params.domain = companyDomain;

  // Invoke MCP tool
  const result = await invokeMcpTool(toolName, params, mcpApiKey);

  // Log the MCP call
  logMcpCall(userId, companyName, result, false).catch(() => {});

  if (result.error || !result.data) {
    console.warn(`[enrichment-mcp] ${source} failed: ${result.error}`);
    return { data: {}, cached: false, success: false };
  }

  // Cache the raw result
  putCache(source, companyName, result.data).catch((err) => {
    console.error(`[enrichment-mcp] cache put failed for ${source}:`, (err as Error).message);
  });

  // Normalize
  const normalize = source === 'crunchbase' ? normalizeCrunchbase : normalizeZoominfo;
  return { data: normalize(result.data), cached: false, success: true };
}
