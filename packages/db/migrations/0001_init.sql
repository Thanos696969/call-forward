-- 0001_init: Phase 1 schema (tables for later phases are created now, not exposed by the API).
-- Copied from the build specification verbatim; any change goes in a new migration.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  timezone text not null default 'America/New_York',
  currency text not null default 'USD',
  wallet_micros bigint not null default 0,
  status text not null default 'active'
    check (status in ('active','suspended','closed')),
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  name text,
  email_verified_at timestamptz,
  status text not null default 'active'
    check (status in ('active','disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','buyer','agent')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table sessions (
  id text primary key,                       -- sha256 hex of the raw token
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  expires_at timestamptz not null,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  status text not null default 'active'
    check (status in ('active','paused','archived')),
  routing_mode text not null default 'sequential'
    check (routing_mode in ('sequential','simultaneous')),
  ring_timeout_sec int not null default 25 check (ring_timeout_sec between 5 and 120),
  recording_enabled boolean not null default false,
  ivr_enabled boolean not null default false,
  ivr_prompt text,
  ivr_digit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table phone_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  country char(2) not null,
  number_type text not null check (number_type in ('toll_free','local')),
  provider text not null check (provider in ('mock','twilio','telnyx')),
  provider_ref text,
  status text not null default 'provisioning'
    check (status in ('provisioning','active','suspended','released')),
  campaign_id uuid references campaigns(id),
  buy_price_micros_per_min bigint not null default 0,
  sell_price_micros_per_min bigint not null default 0,
  monthly_fee_micros bigint not null default 0,
  capabilities jsonb not null default '{}',
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index phone_numbers_active_e164
  on phone_numbers (e164) where status <> 'released';
create index phone_numbers_org_idx on phone_numbers (org_id, created_at desc);

create table targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  target_type text not null default 'phone'
    check (target_type in ('phone','sip','agent')),
  name text not null,
  destination text not null,
  weight int not null default 100 check (weight >= 0),
  priority_tier int not null default 1 check (priority_tier >= 1),
  cc_cap int not null default 10 check (cc_cap > 0),
  hourly_cap int,
  daily_cap int,
  total_cap int,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table schedules (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references targets(id) on delete cascade,
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now()
);

create table schedule_windows (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  day_of_week smallint check (day_of_week between 0 and 6),
  open_time time,
  close_time time,
  date_start date,
  date_end date,
  check (
    (day_of_week is not null and open_time is not null and close_time is not null)
    or (date_start is not null and date_end is not null)
  )
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid references campaigns(id),
  number_id uuid references phone_numbers(id),
  target_id uuid references targets(id),
  provider text not null,
  provider_call_id text not null,
  direction text not null default 'inbound',
  from_e164 text not null,
  to_e164 text not null,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  ring_seconds int,
  talk_seconds int,
  billed_seconds int,
  outcome text not null default 'in_progress'
    check (outcome in ('in_progress','completed','no_answer','busy','failed','rejected','blocked','screened_out','abandoned')),
  hangup_cause text,
  sip_code int,
  cost_micros bigint not null default 0,
  revenue_micros bigint not null default 0,
  recording_id uuid,
  is_repeat boolean not null default false,
  repeat_count int not null default 0,
  metadata jsonb not null default '{}'
);
create unique index calls_provider_call_idx on calls (provider, provider_call_id);
create index calls_org_started_idx on calls (org_id, started_at desc);
create index calls_repeat_idx on calls (campaign_id, from_e164, started_at desc);

create table call_legs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  target_id uuid references targets(id),
  attempt int not null default 1,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  outcome text,
  sip_code int
);
create index call_legs_call_idx on call_legs (call_id, attempt);

create table recordings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  storage_key text not null,
  duration_sec int,
  expires_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table wallet_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('topup','usage','refund','adjustment','number_fee','payout')),
  amount_micros bigint not null,
  balance_after_micros bigint not null,
  ref_type text,
  ref_id text,
  description text,
  created_at timestamptz not null default now(),
  unique (ref_type, ref_id, kind)
);

create table audit_logs (
  id bigserial primary key,
  org_id uuid references organizations(id) on delete cascade,
  actor_user_id uuid references users(id),
  action text not null,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on audit_logs (org_id, created_at desc);
