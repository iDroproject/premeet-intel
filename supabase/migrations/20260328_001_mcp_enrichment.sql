-- PreMeet — MCP Enrichment Support
-- Migration: 20260328_001_mcp_enrichment
--
-- Adds columns to enrichment_requests for MCP tool call tracking:
--   tool_name   — which MCP tool was invoked (e.g. web_data_crunchbase_company)
--   latency_ms  — round-trip time for the MCP call
--
-- Also adds an index for per-source cache key lookups used by the new
-- enrichment-mcp edge function (keys like crunchbase:company:{name}).

-- ── New columns on enrichment_requests ─────────────────────────────────────

alter table enrichment_requests
  add column if not exists tool_name text,
  add column if not exists latency_ms int;

comment on column enrichment_requests.tool_name is 'MCP tool name (e.g. web_data_crunchbase_company). NULL for non-MCP requests.';
comment on column enrichment_requests.latency_ms is 'Round-trip latency in milliseconds for the enrichment call.';

-- ── Index for MCP cost tracking queries ────────────────────────────────────

create index if not exists idx_enrichment_requests_tool
  on enrichment_requests(tool_name, requested_at desc)
  where tool_name is not null;
