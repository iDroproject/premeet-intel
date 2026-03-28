-- PreMeet Neon DB Schema (consolidated)
-- Application-layer auth enforced in Edge Functions via JWT middleware.

-- ─── Extensions ─────────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── Custom Types ───────────────────────────────────────────────────────────

create type subscription_tier as enum ('free', 'pro', 'enterprise');
create type entity_type       as enum ('person', 'company');
create type enrichment_status as enum ('pending', 'success', 'partial', 'failed', 'cached');
create type confidence_level  as enum ('high', 'good', 'partial', 'low');

-- ─── Updated-at trigger function ────────────────────────────────────────────

create or replace function trigger_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ─── Users ──────────────────────────────────────────────────────────────────

create table users (
  id                uuid primary key default uuid_generate_v4(),
  email             text not null unique,
  name              text,
  google_oauth_id   text unique,
  subscription_tier subscription_tier not null default 'free',
  credits_used      int not null default 0,
  credits_limit     int not null default 10,
  credits_reset_month text not null default to_char(now(), 'YYYY-MM'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table users is 'PreMeet user accounts linked via Google OAuth';

create index idx_users_google_oauth_id on users(google_oauth_id) where google_oauth_id is not null;
create index idx_users_email on users(email);

create trigger set_users_updated_at
  before update on users
  for each row execute function trigger_set_updated_at();

-- ─── Enrichment Cache ───────────────────────────────────────────────────────

create table enrichment_cache (
  id               uuid primary key default uuid_generate_v4(),
  entity_type      entity_type not null,
  entity_key       text not null,
  enrichment_data  jsonb not null,
  confidence       confidence_level,
  confidence_score numeric(5,2),
  source           text,
  fetched_at       timestamptz not null default now(),
  expires_at       timestamptz not null default (now() + interval '7 days'),
  created_at       timestamptz not null default now()
);

comment on table enrichment_cache is 'Cached Brightdata enrichment results shared across users';

alter table enrichment_cache
  add constraint uq_enrichment_cache_entity unique (entity_type, entity_key);

create index idx_enrichment_cache_lookup on enrichment_cache(entity_type, entity_key);
create index idx_enrichment_cache_expires on enrichment_cache(expires_at);

-- ─── Sessions ───────────────────────────────────────────────────────────────

create table sessions (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

comment on table sessions is 'User session tokens for API authentication';

create index idx_sessions_token_hash on sessions(token_hash);
create index idx_sessions_user_id on sessions(user_id);
create index idx_sessions_expires on sessions(expires_at);

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

create index idx_enrichment_requests_user on enrichment_requests(user_id, requested_at desc);
create index idx_enrichment_requests_entity on enrichment_requests(entity_type, entity_key);
create index idx_enrichment_requests_status on enrichment_requests(status) where status = 'pending';

-- ─── Cache Stats ────────────────────────────────────────────────────────────

create table cache_stats (
  id          uuid primary key default uuid_generate_v4(),
  date        date not null,
  entity_type entity_type not null,
  hits        int not null default 0,
  misses      int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table cache_stats is 'Daily cache hit/miss counters per entity type for monitoring';

alter table cache_stats
  add constraint uq_cache_stats_date_entity unique (date, entity_type);

create index idx_cache_stats_date on cache_stats(date desc);

create trigger set_cache_stats_updated_at
  before update on cache_stats
  for each row execute function trigger_set_updated_at();

-- ─── Upsert Cache Stat RPC ─────────────────────────────────────────────────

create or replace function upsert_cache_stat(
  p_date date,
  p_entity_type entity_type,
  p_hits int default 0,
  p_misses int default 0
)
returns void
language plpgsql
security definer
as $$
begin
  insert into cache_stats (date, entity_type, hits, misses)
  values (p_date, p_entity_type, p_hits, p_misses)
  on conflict (date, entity_type)
  do update set
    hits = cache_stats.hits + excluded.hits,
    misses = cache_stats.misses + excluded.misses,
    updated_at = now();
end;
$$;

-- ─── Subscriptions ──────────────────────────────────────────────────────────

create table subscriptions (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null references users(id) on delete cascade,
  stripe_customer_id      text not null,
  stripe_subscription_id  text unique,
  tier                    subscription_tier not null default 'free',
  status                  text not null default 'active',
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table subscriptions is 'Stripe subscription records linked to user accounts';

alter table subscriptions
  add constraint uq_subscriptions_user unique (user_id);

create index idx_subscriptions_stripe_customer on subscriptions(stripe_customer_id);
create index idx_subscriptions_stripe_subscription on subscriptions(stripe_subscription_id)
  where stripe_subscription_id is not null;
create index idx_subscriptions_status on subscriptions(status);

create trigger set_subscriptions_updated_at
  before update on subscriptions
  for each row execute function trigger_set_updated_at();

-- ─── Billing Events ────────────────────────────────────────────────────────

create table billing_events (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete set null,
  stripe_event_id text not null unique,
  event_type      text not null,
  data            jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

comment on table billing_events is 'Audit log of Stripe webhook events for billing traceability';

create index idx_billing_events_user on billing_events(user_id) where user_id is not null;
create index idx_billing_events_type on billing_events(event_type);
create index idx_billing_events_created on billing_events(created_at desc);
