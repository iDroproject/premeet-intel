-- 004_hardening.sql
-- Production hardening: server-side rate limiting, expiry purge helper, and
-- migration tracking. Fully idempotent (safe to re-run).

-- ── Migration ledger ────────────────────────────────────────────────────────
-- Lets the runner skip files that have already been applied, so the
-- non-idempotent 001_initial_schema.sql is never re-executed on an existing DB.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Per-user daily API rate limit (anti-abuse ceiling for enrichment-proxy) ──

CREATE TABLE IF NOT EXISTS api_rate_limits (
  user_id      uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_date  date  NOT NULL DEFAULT current_date,
  op_count     int   NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_date)
);

COMMENT ON TABLE api_rate_limits IS 'Per-user, per-day count of billable BrightData trigger ops proxied through enrichment-proxy.';

CREATE INDEX IF NOT EXISTS idx_api_rate_limits_date ON api_rate_limits(window_date);

-- ── Expiry purge helper ─────────────────────────────────────────────────────
-- Deletes long-expired cache entries (past the stale grace window) and expired
-- sessions and old rate-limit rows. Invoked by the scheduled cleanup endpoint.

CREATE OR REPLACE FUNCTION purge_expired()
RETURNS TABLE(cache_deleted int, sessions_deleted int, rate_rows_deleted int)
LANGUAGE plpgsql
AS $$
DECLARE
  c int;
  s int;
  r int;
BEGIN
  DELETE FROM enrichment_cache WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS c = ROW_COUNT;

  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS s = ROW_COUNT;

  DELETE FROM api_rate_limits WHERE window_date < current_date - 7;
  GET DIAGNOSTICS r = ROW_COUNT;

  RETURN QUERY SELECT c, s, r;
END;
$$;
