-- PreMeet Cache Statistics
-- Migration: 20260324_002_cache_stats
-- Tracks cache hit/miss rates per day per entity type for monitoring.

-- ─── Cache Stats Table ────────────────────────────────────────────────────────

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

-- One row per date + entity type
alter table cache_stats
  add constraint uq_cache_stats_date_entity unique (date, entity_type);

-- Index for recent stats queries
create index idx_cache_stats_date on cache_stats(date desc);

-- Updated-at trigger
create trigger set_cache_stats_updated_at
  before update on cache_stats
  for each row execute function trigger_set_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

alter table cache_stats enable row level security;

-- Cache stats are readable by authenticated users (for monitoring dashboards)
create policy cache_stats_select_authenticated on cache_stats
  for select using (auth.role() = 'authenticated');

-- Only service role can insert/update (via backend RPC)

-- ─── Upsert RPC ──────────────────────────────────────────────────────────────
-- Atomically increments hit/miss counters for a given date + entity type.
-- Called by the enrichment cache service on every lookup.

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
