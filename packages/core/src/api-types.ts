import type { CallOutcome } from './outcome';

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

export interface NumberDto {
  id: string;
  e164: string;
  country: string;
  numberType: 'toll_free' | 'local';
  provider: 'mock' | 'twilio' | 'telnyx';
  status: NumberStatus;
  forwarding: ForwardingDto;
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
