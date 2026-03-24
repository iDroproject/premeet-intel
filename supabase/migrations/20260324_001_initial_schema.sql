-- PreMeet Initial Database Schema
-- Migration: 20260324_001_initial_schema
-- Creates core tables: users, enrichment_cache, sessions, enrichment_requests

-- ─── Extensions ─────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── Custom Types ───────────────────────────────────────────────────────────

create type subscription_tier as enum ('free', 'pro');
create type entity_type as enum ('person', 'company');
create type enrichment_status as enum ('pending', 'success', 'partial', 'failed', 'cached');
create type confidence_level as enum ('high', 'good', 'partial', 'low');

-- ─── Users ──────────────────────────────────────────────────────────────────

create table users (
  id            uuid primary key default uuid_generate_v4(),
  email         text not null unique,
  name          text,
  google_oauth_id text unique,
  subscription_tier subscription_tier not null default 'free',
  credits_used  int not null default 0,
  credits_limit int not null default 10,
  credits_reset_month text not null default to_char(now(), 'YYYY-MM'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table users is 'PreMeet user accounts linked via Google OAuth';

-- ─── Enrichment Cache ───────────────────────────────────────────────────────

create table enrichment_cache (
  id              uuid primary key default uuid_generate_v4(),
  entity_type     entity_type not null,
  entity_key      text not null,
  enrichment_data jsonb not null,
  confidence      confidence_level,
  confidence_score numeric(5,2),
  source          text,
  fetched_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  created_at      timestamptz not null default now()
);

comment on table enrichment_cache is 'Cached Brightdata enrichment results shared across users';

-- Unique constraint: one cache entry per entity type + key
alter table enrichment_cache
  add constraint uq_enrichment_cache_entity unique (entity_type, entity_key);

-- ─── Sessions ───────────────────────────────────────────────────────────────

create table sessions (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

comment on table sessions is 'User session tokens for API authentication';

-- ─── Enrichment Requests ────────────────────────────────────────────────────

create table enrichment_requests (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references users(id) on delete cascade,
  entity_type   entity_type not null,
  entity_key    text not null,
  credits_used  int not null default 1,
  status        enrichment_status not null default 'pending',
  cache_hit     boolean not null default false,
  meeting_title text,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz
);

comment on table enrichment_requests is 'Audit log of enrichment API calls and credit usage';

-- ─── Indexes ────────────────────────────────────────────────────────────────

-- Users: fast lookup by Google OAuth ID and email
create index idx_users_google_oauth_id on users(google_oauth_id) where google_oauth_id is not null;
create index idx_users_email on users(email);

-- Enrichment cache: primary lookup path (type + key), expiry cleanup
create index idx_enrichment_cache_lookup on enrichment_cache(entity_type, entity_key);
create index idx_enrichment_cache_expires on enrichment_cache(expires_at);

-- Sessions: lookup by token hash, cleanup of expired sessions
create index idx_sessions_token_hash on sessions(token_hash);
create index idx_sessions_user_id on sessions(user_id);
create index idx_sessions_expires on sessions(expires_at);

-- Enrichment requests: user activity log, status filtering
create index idx_enrichment_requests_user on enrichment_requests(user_id, requested_at desc);
create index idx_enrichment_requests_entity on enrichment_requests(entity_type, entity_key);
create index idx_enrichment_requests_status on enrichment_requests(status) where status = 'pending';

-- ─── Updated-at trigger ─────────────────────────────────────────────────────

create or replace function trigger_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_users_updated_at
  before update on users
  for each row execute function trigger_set_updated_at();

-- ─── Row Level Security ─────────────────────────────────────────────────────

-- Enable RLS on all tables
alter table users enable row level security;
alter table sessions enable row level security;
alter table enrichment_requests enable row level security;
alter table enrichment_cache enable row level security;

-- Users: can only read/update own row
-- auth.uid() is Supabase's built-in function that returns the authenticated user's ID
create policy users_select_own on users
  for select using (id = auth.uid());

create policy users_update_own on users
  for update using (id = auth.uid())
  with check (id = auth.uid());

-- Sessions: users can only see/manage their own sessions
create policy sessions_select_own on sessions
  for select using (user_id = auth.uid());

create policy sessions_insert_own on sessions
  for insert with check (user_id = auth.uid());

create policy sessions_delete_own on sessions
  for delete using (user_id = auth.uid());

-- Enrichment requests: users see only their own request history
create policy enrichment_requests_select_own on enrichment_requests
  for select using (user_id = auth.uid());

create policy enrichment_requests_insert_own on enrichment_requests
  for insert with check (user_id = auth.uid());

-- Enrichment cache: readable by all authenticated users (shared cache)
-- Only service role can insert/update (via backend API)
create policy enrichment_cache_select_authenticated on enrichment_cache
  for select using (auth.role() = 'authenticated');

-- ─── Service-role policies for backend API ──────────────────────────────────
-- The service_role bypasses RLS by default in Supabase, so these are
-- documented here for clarity but not strictly required.
-- Backend operations (cache writes, credit deductions) use the service_role key.
