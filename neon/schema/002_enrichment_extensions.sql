-- 002_enrichment_extensions.sql
-- Extends schema for company intel, contact info, and custom enrichment features.

-- ─── Extend entity_type enum ──────────────────────────────────────────────────

ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'company_intel';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'contact_info';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'custom_enrichment';

-- ─── Enrichment Prompts ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS enrichment_prompts (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_key   text NOT NULL,
  prompt       text NOT NULL,
  result_data  jsonb,
  credits_used int NOT NULL DEFAULT 2,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE enrichment_prompts IS 'Custom enrichment prompts submitted by users with AI-generated results';

CREATE INDEX IF NOT EXISTS idx_enrichment_prompts_user_entity
  ON enrichment_prompts(user_id, entity_key);

CREATE INDEX IF NOT EXISTS idx_enrichment_prompts_created
  ON enrichment_prompts(created_at DESC);
