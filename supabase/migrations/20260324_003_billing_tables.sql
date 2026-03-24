-- PreMeet Billing Tables
-- Migration: 20260324_003_billing_tables
-- Creates tables for Stripe subscription management and billing event tracking.

-- ─── Update subscription_tier enum ────────────────────────────────────────────
-- Add 'enterprise' tier to support three-tier pricing.

alter type subscription_tier add value if not exists 'enterprise';

-- ─── Subscriptions ────────────────────────────────────────────────────────────

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

-- One subscription per user
alter table subscriptions
  add constraint uq_subscriptions_user unique (user_id);

-- Lookup by Stripe IDs
create index idx_subscriptions_stripe_customer on subscriptions(stripe_customer_id);
create index idx_subscriptions_stripe_subscription on subscriptions(stripe_subscription_id)
  where stripe_subscription_id is not null;
create index idx_subscriptions_status on subscriptions(status);

-- Updated-at trigger
create trigger set_subscriptions_updated_at
  before update on subscriptions
  for each row execute function trigger_set_updated_at();

-- ─── Billing Events ──────────────────────────────────────────────────────────

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

-- ─── Row Level Security ──────────────────────────────────────────────────────

alter table subscriptions enable row level security;
alter table billing_events enable row level security;

-- Users can read their own subscription
create policy subscriptions_select_own on subscriptions
  for select using (user_id = auth.uid());

-- Users can read their own billing events
create policy billing_events_select_own on billing_events
  for select using (user_id = auth.uid());

-- All writes to subscriptions and billing_events are done via service_role
-- (backend webhook handler), which bypasses RLS by default.
