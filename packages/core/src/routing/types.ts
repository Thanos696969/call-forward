/**
 * Phase 2 routing model. A compiled route is everything the voice path needs to
 * answer a call without touching Postgres; it is cached in Redis as `route:{e164}`.
 */

export type RoutingMode = 'sequential' | 'simultaneous';
export const ROUTING_MODES: readonly RoutingMode[] = ['sequential', 'simultaneous'];

export type AttestationPolicy = 'allow_all' | 'block_failed' | 'require_a_or_b' | 'require_a';
export const ATTESTATION_POLICIES: readonly AttestationPolicy[] = [
  'allow_all',
  'block_failed',
  'require_a_or_b',
  'require_a',
];

export type CampaignStatus = 'active' | 'paused' | 'archived';
export type TargetType = 'phone' | 'sip' | 'agent';

/** "HH:MM", 24-hour, local to the schedule's timezone. */
export type ClockTime = string;
/** "YYYY-MM-DD", local to the schedule's timezone. */
export type LocalDate = string;

/**
 * Recurring opening hours. `close <= open` means the window crosses midnight
 * (Fri 22:00–02:00 covers Saturday 00:00–02:00); `open == close` is 24 hours.
 */
export interface WeeklyWindow {
  type: 'weekly';
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  open: ClockTime;
  close: ClockTime;
}

/**
 * A date range that overrides the weekly hours: `closed` blacks the dates out
 * (holidays); `open` replaces the weekly hours on those dates, all day when no
 * times are given.
 */
export interface DatedWindow {
  type: 'date';
  start: LocalDate;
  end: LocalDate;
  kind: 'open' | 'closed';
  open: ClockTime | null;
  close: ClockTime | null;
}

export type ScheduleWindow = WeeklyWindow | DatedWindow;

export interface ScheduleSpec {
  timezone: string;
  windows: ScheduleWindow[];
}

export interface CompiledTarget {
  id: string;
  name: string;
  type: TargetType;
  destination: string;
  priorityTier: number;
  weight: number;
  enabled: boolean;
  ccCap: number;
  hourlyCap: number | null;
  dailyCap: number | null;
  totalCap: number | null;
  /** null = always open. */
  schedule: ScheduleSpec | null;
  /** Hourly/daily caps reset on this timezone's clock (schedule tz, else org tz). */
  capTimezone: string;
}

export interface CompiledCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  routingMode: RoutingMode;
  ringTimeoutSec: number;
  ivr: {
    enabled: boolean;
    prompt: string | null;
    digit: string | null;
    randomDigit: boolean;
    timeoutSec: number;
  };
  protection: {
    attestationPolicy: AttestationPolicy;
    perMinute: number | null;
    perHour: number | null;
  };
  unavailableMessage: string | null;
}

export interface CompiledRoute {
  version: 2;
  numberId: string;
  orgId: string;
  orgTimezone: string;
  e164: string;
  orgStatus: 'active' | 'suspended' | 'closed';
  campaign: CompiledCampaign | null;
  /** Non-archived targets, sorted by tier, then creation order. */
  targets: CompiledTarget[];
}

/** Why a target was not dialled on an attempt. */
export type IneligibleReason =
  | 'disabled'
  | 'unsupported_type'
  | 'zero_weight'
  | 'already_tried'
  | 'outside_schedule'
  | 'cc_cap'
  | 'hourly_cap'
  | 'daily_cap'
  | 'total_cap';

export type TargetVerdict = 'picked' | 'not_picked' | IneligibleReason;

export interface TargetExplanation {
  targetId: string;
  name: string;
  verdict: TargetVerdict;
  /** Live counters seen by the reservation, when it ran for this target. */
  usage?: { concurrent: number; hour: number; day: number; total: number };
}

export interface TierExplanation {
  tier: number;
  targets: TargetExplanation[];
}

export const VERDICT_LABEL: Record<TargetVerdict, string> = {
  picked: 'Dialled',
  not_picked: 'Eligible, another target was picked by weight',
  disabled: 'Disabled',
  unsupported_type: 'Destination type not supported yet',
  zero_weight: 'Weight is 0',
  already_tried: 'Already rung on this call',
  outside_schedule: 'Outside its schedule',
  cc_cap: 'At its concurrent-call cap',
  hourly_cap: 'Hourly cap reached',
  daily_cap: 'Daily cap reached',
  total_cap: 'Total cap reached',
};
