-- 0003_routing_engine: Phase 2 (campaigns, targets, schedules, failover, IVR, protection).

-- ── Campaign settings ────────────────────────────────────────────────────────
alter table campaigns
  add column ivr_random_digit boolean not null default false,
  add column ivr_timeout_sec int not null default 8 check (ivr_timeout_sec between 3 and 30),
  add column attestation_policy text not null default 'allow_all'
    check (attestation_policy in ('allow_all', 'block_failed', 'require_a_or_b', 'require_a')),
  add column caller_limit_per_minute int check (caller_limit_per_minute > 0),
  add column caller_limit_per_hour int check (caller_limit_per_hour > 0),
  add column unavailable_message text check (char_length(unavailable_message) <= 300);

alter table campaigns
  add constraint campaigns_ivr_digit_check check (ivr_digit is null or ivr_digit ~ '^[0-9]$'),
  add constraint campaigns_ivr_prompt_len check (ivr_prompt is null or char_length(ivr_prompt) <= 300);

create index campaigns_org_idx on campaigns (org_id, created_at desc);

-- ── Targets: soft delete (calls keep referencing archived targets) ──────────
alter table targets
  add column archived_at timestamptz,
  add constraint targets_caps_positive check (
    (hourly_cap is null or hourly_cap > 0) and
    (daily_cap is null or daily_cap > 0) and
    (total_cap is null or total_cap > 0)
  ),
  add constraint targets_weight_max check (weight <= 1000),
  add constraint targets_tier_max check (priority_tier <= 10);

-- ── Schedules: one per target; dated windows can open or close a date range ─
create unique index schedules_target_uidx on schedules (target_id);
alter table schedule_windows
  add column kind text not null default 'open' check (kind in ('open', 'closed'));
create index schedule_windows_schedule_idx on schedule_windows (schedule_id);

-- ── Call legs: several legs per attempt when ringing simultaneously ─────────
drop index call_legs_call_attempt_uidx;
create unique index call_legs_call_attempt_target_uidx on call_legs (call_id, attempt, target_id);
alter table call_legs
  add column destination text,
  add column tier int,
  add column provider_leg_id text,
  add column talk_seconds int,
  add column released_at timestamptz;
-- Cap reconciliation counts legs per target per window; the reaper scans open legs.
create index call_legs_target_started_idx on call_legs (target_id, started_at);
create index call_legs_open_idx on call_legs (started_at) where ended_at is null;

-- ── One row per dial attempt: lets retried webhooks rebuild the same answer ─
create table call_attempts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  attempt int not null check (attempt >= 1),
  mode text not null check (mode in ('sequential', 'simultaneous')),
  tier int not null,
  ring_timeout_sec int not null,
  dial_status text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (call_id, attempt)
);

-- ── Why the router did what it did (admin routing debug) ───────────────────
create table call_routing_events (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  attempt int,
  kind text not null check (kind in ('protection', 'ivr', 'attempt', 'exhausted', 'fallback')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index call_routing_events_call_idx on call_routing_events (call_id, id);

-- ── Blocked callers (organisation-wide) ─────────────────────────────────────
create table blocklist_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  reason text check (char_length(reason) <= 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (org_id, e164)
);

-- Live calls view.
create index calls_org_in_progress_idx on calls (org_id, started_at desc) where outcome = 'in_progress';
