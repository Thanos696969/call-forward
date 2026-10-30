import type { CallOutcome } from './outcome';
import type {
  AttestationPolicy,
  CampaignStatus,
  RoutingMode,
  ScheduleWindow,
  TargetVerdict,
  TierExplanation,
} from './routing/types';

/** Response DTOs shared by the API and the web app. Timestamps are ISO-8601 UTC strings. */

export type Role = 'owner' | 'admin' | 'member' | 'buyer' | 'agent';

export interface ApiEnvelope<T, M = Record<string, unknown>> {
  data: T;
  meta?: M;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface UserDto {
  id: string;
  email: string;
  name: string | null;
}

export interface OrgDto {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: 'active' | 'suspended' | 'closed';
  createdAt: string;
}

export interface MeDto {
  user: UserDto;
  org: OrgDto;
  role: Role;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
}

export interface AuditLogDto {
  id: string;
  action: string;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export type NumberStatus = 'provisioning' | 'active' | 'suspended' | 'released';

export interface ForwardingDto {
  forwardTo: string | null;
  ringTimeoutSec: number;
  enabled: boolean;
}

export interface NumberCampaignDto {
  id: string;
  name: string;
  status: CampaignStatus;
  /** One number and at most one target: the simple forwarding form can edit it. */
  simple: boolean;
}

export interface NumberDto {
  id: string;
  e164: string;
  country: string;
  numberType: 'toll_free' | 'local';
  provider: 'mock' | 'twilio' | 'telnyx';
  status: NumberStatus;
  forwarding: ForwardingDto;
  campaign: NumberCampaignDto | null;
  createdAt: string;
  releasedAt: string | null;
}

export interface AvailableNumberDto {
  e164: string;
  country: string;
  numberType: 'toll_free' | 'local';
  region: string | null;
}

export interface CallLegDto {
  id: string;
  attempt: number;
  tier: number | null;
  targetId: string | null;
  targetName: string | null;
  talkSeconds: number | null;
  destination: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  outcome: string | null;
  sipCode: number | null;
}

export interface CallDto {
  id: string;
  numberId: string | null;
  numberE164: string;
  from: string;
  destination: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  billedSeconds: number | null;
  outcome: CallOutcome;
  provider: string;
}

export interface CallDetailDto extends CallDto {
  providerCallId: string;
  hangupCause: string | null;
  metadata: Record<string, unknown>;
  campaign: { id: string; name: string } | null;
  attempts: CallAttemptDto[];
  legs: CallLegDto[];
}

export interface DashboardDayDto {
  /** YYYY-MM-DD in the organisation timezone. */
  date: string;
  calls: number;
  answered: number;
  minutes: number;
}

export interface DashboardSummaryDto {
  from: string;
  to: string;
  timezone: string;
  calls: number;
  answered: number;
  /** 0..1, rounded to 4 decimals. */
  answerRate: number;
  /** Talk time in whole minutes (seconds / 60, rounded up per call total). */
  minutes: number;
  talkSeconds: number;
  completed: number;
  missed: number;
  failed: number;
  daily: DashboardDayDto[];
}

// ── Phase 2: routing ──────────────────────────────────────────────────────────

export interface TargetUsageDto {
  concurrent: number;
  hour: number;
  day: number;
  total: number;
}

export interface ScheduleDto {
  timezone: string;
  windows: ScheduleWindow[];
}

export interface TargetDto {
  id: string;
  name: string;
  type: 'phone' | 'sip' | 'agent';
  destination: string;
  priorityTier: number;
  weight: number;
  ccCap: number;
  hourlyCap: number | null;
  dailyCap: number | null;
  totalCap: number | null;
  enabled: boolean;
  schedule: ScheduleDto | null;
  /** Live counters from Redis; null when unavailable. */
  usage: TargetUsageDto | null;
  /** Is the target inside its schedule right now? */
  openNow: boolean;
  createdAt: string;
}

export interface CampaignSummaryDto {
  id: string;
  name: string;
  status: CampaignStatus;
  routingMode: RoutingMode;
  ringTimeoutSec: number;
  numbers: number;
  targets: number;
  enabledTargets: number;
  ivrEnabled: boolean;
  createdAt: string;
}

export interface CampaignDto extends CampaignSummaryDto {
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
  attachedNumbers: Array<{ id: string; e164: string; status: NumberStatus }>;
  targetList: TargetDto[];
}

export interface BlocklistEntryDto {
  id: string;
  e164: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface LiveLegDto {
  targetId: string | null;
  targetName: string | null;
  destination: string | null;
  attempt: number;
  state: 'ringing' | 'connected';
  startedAt: string;
  answeredAt: string | null;
}

export interface LiveCallDto {
  id: string;
  from: string;
  numberE164: string;
  campaign: { id: string; name: string } | null;
  startedAt: string;
  state: 'ivr' | 'ringing' | 'connected' | 'routing';
  attempt: number;
  legs: LiveLegDto[];
}

export interface CallAttemptDto {
  attempt: number;
  mode: RoutingMode;
  tier: number;
  ringTimeoutSec: number;
  dialStatus: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RoutingEventDto {
  id: string;
  kind: 'protection' | 'ivr' | 'attempt' | 'exhausted' | 'fallback';
  attempt: number | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ExplainTargetDto {
  targetId: string;
  name: string;
  destination: string;
  verdict: TargetVerdict | 'eligible';
  usage: TargetUsageDto | null;
  /** Probability of being picked if the call arrived now (sequential mode). */
  chance: number | null;
}

export interface ExplainDto {
  at: string;
  mode: RoutingMode;
  campaignStatus: CampaignStatus;
  /** The tier a call arriving now would ring, or null if nothing is eligible. */
  wouldRingTier: number | null;
  tiers: Array<{ tier: number; targets: ExplainTargetDto[] }>;
}

export type { TierExplanation };
