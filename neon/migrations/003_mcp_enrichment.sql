-- 003_mcp_enrichment.sql
-- Adds columns to enrichment_requests for MCP tool call tracking:
--   tool_name   — which MCP tool was invoked (e.g. web_data_crunchbase_company)
--   latency_ms  — round-trip time for the MCP call
--
-- Also adds an index for per-source cache key lookups used by the new
-- enrichment-mcp edge function (keys like crunchbase:company:{name}).

-- ── New columns on enrichment_requests ─────────────────────────────────────

ALTER TABLE enrichment_requests
  ADD COLUMN IF NOT EXISTS tool_name text,
  ADD COLUMN IF NOT EXISTS latency_ms int;

COMMENT ON COLUMN enrichment_requests.tool_name IS 'MCP tool name (e.g. web_data_crunchbase_company). NULL for non-MCP requests.';
COMMENT ON COLUMN enrichment_requests.latency_ms IS 'Round-trip latency in milliseconds for the enrichment call.';

-- ── Index for MCP cost tracking queries ────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_enrichment_requests_tool
  ON enrichment_requests(tool_name, requested_at DESC)
  WHERE tool_name IS NOT NULL;
