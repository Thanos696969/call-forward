-- 0002_phase1_support: indexes and constraints used by Phase 1 code paths.

-- Only one leg row per attempt, so a retried inbound webhook cannot add a duplicate leg.
create unique index call_legs_call_attempt_uidx on call_legs (call_id, attempt);

-- Session lookups by user (logout everywhere on password reset) and expiry sweeps.
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

-- Membership lookups by user (login resolves the user's organisation).
create index memberships_user_idx on memberships (user_id);

-- Targets by campaign (route compilation).
create index targets_campaign_idx on targets (campaign_id, priority_tier, created_at);

-- Call log filter by number.
create index calls_org_number_started_idx on calls (org_id, number_id, started_at desc);
