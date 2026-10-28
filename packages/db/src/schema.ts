import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of migrations/*.sql. The SQL files are the source of truth for
 * DDL (constraints, partial indexes); this file gives typed queries.
 */

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const inet = customType<{ data: string }>({ dataType: () => 'inet' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const micros = (name: string) => bigint(name, { mode: 'bigint' });

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: citext('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/New_York'),
  currency: text('currency').notNull().default('USD'),
  walletMicros: micros('wallet_micros')
    .notNull()
    .default(sql`0`),
  status: text('status', { enum: ['active', 'suspended', 'closed'] })
    .notNull()
    .default('active'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name'),
  emailVerifiedAt: ts('email_verified_at'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const ROLES = ['owner', 'admin', 'member', 'buyer', 'agent'] as const;

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ROLES }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'paused', 'archived'] })
    .notNull()
    .default('active'),
  routingMode: text('routing_mode', { enum: ['sequential', 'simultaneous'] })
    .notNull()
    .default('sequential'),
  ringTimeoutSec: integer('ring_timeout_sec').notNull().default(25),
  recordingEnabled: boolean('recording_enabled').notNull().default(false),
  ivrEnabled: boolean('ivr_enabled').notNull().default(false),
  ivrPrompt: text('ivr_prompt'),
  ivrDigit: text('ivr_digit'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const phoneNumbers = pgTable('phone_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  e164: text('e164').notNull(),
  country: char('country', { length: 2 }).notNull(),
  numberType: text('number_type', { enum: ['toll_free', 'local'] }).notNull(),
  provider: text('provider', { enum: ['mock', 'twilio', 'telnyx'] }).notNull(),
  providerRef: text('provider_ref'),
  status: text('status', { enum: ['provisioning', 'active', 'suspended', 'released'] })
    .notNull()
    .default('provisioning'),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  buyPriceMicrosPerMin: micros('buy_price_micros_per_min')
    .notNull()
    .default(sql`0`),
  sellPriceMicrosPerMin: micros('sell_price_micros_per_min')
    .notNull()
    .default(sql`0`),
  monthlyFeeMicros: micros('monthly_fee_micros')
    .notNull()
    .default(sql`0`),
  capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  releasedAt: ts('released_at'),
});

export const targets = pgTable('targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id')
    .notNull()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  targetType: text('target_type', { enum: ['phone', 'sip', 'agent'] })
    .notNull()
    .default('phone'),
  name: text('name').notNull(),
  destination: text('destination').notNull(),
  weight: integer('weight').notNull().default(100),
  priorityTier: integer('priority_tier').notNull().default(1),
  ccCap: integer('cc_cap').notNull().default(10),
  hourlyCap: integer('hourly_cap'),
  dailyCap: integer('daily_cap'),
  totalCap: integer('total_cap'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetId: uuid('target_id')
    .notNull()
    .references(() => targets.id, { onDelete: 'cascade' }),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const scheduleWindows = pgTable('schedule_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id')
    .notNull()
    .references(() => schedules.id, { onDelete: 'cascade' }),
  dayOfWeek: smallint('day_of_week'),
  openTime: time('open_time'),
  closeTime: time('close_time'),
  dateStart: date('date_start'),
  dateEnd: date('date_end'),
});

export const OUTCOMES = [
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'rejected',
  'blocked',
  'screened_out',
  'abandoned',
] as const;

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  numberId: uuid('number_id').references(() => phoneNumbers.id),
  targetId: uuid('target_id').references(() => targets.id),
  provider: text('provider').notNull(),
  providerCallId: text('provider_call_id').notNull(),
  direction: text('direction').notNull().default('inbound'),
  fromE164: text('from_e164').notNull(),
  toE164: text('to_e164').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  answeredAt: ts('answered_at'),
  endedAt: ts('ended_at'),
  ringSeconds: integer('ring_seconds'),
  talkSeconds: integer('talk_seconds'),
  billedSeconds: integer('billed_seconds'),
  outcome: text('outcome', { enum: OUTCOMES }).notNull().default('in_progress'),
  hangupCause: text('hangup_cause'),
  sipCode: integer('sip_code'),
  costMicros: micros('cost_micros')
    .notNull()
    .default(sql`0`),
  revenueMicros: micros('revenue_micros')
    .notNull()
    .default(sql`0`),
  recordingId: uuid('recording_id'),
  isRepeat: boolean('is_repeat').notNull().default(false),
  repeatCount: integer('repeat_count').notNull().default(0),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});

export const callLegs = pgTable('call_legs', {
  id: uuid('id').primaryKey().defaultRandom(),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  targetId: uuid('target_id').references(() => targets.id),
  attempt: integer('attempt').notNull().default(1),
  startedAt: ts('started_at').notNull().defaultNow(),
  answeredAt: ts('answered_at'),
  endedAt: ts('ended_at'),
  outcome: text('outcome'),
  sipCode: integer('sip_code'),
});

export const recordings = pgTable('recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  durationSec: integer('duration_sec'),
  expiresAt: ts('expires_at').notNull(),
  deletedAt: ts('deleted_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const walletEntries = pgTable('wallet_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['topup', 'usage', 'refund', 'adjustment', 'number_fee', 'payout'],
  }).notNull(),
  amountMicros: micros('amount_micros').notNull(),
  balanceAfterMicros: micros('balance_after_micros').notNull(),
  refType: text('ref_type'),
  refId: text('ref_id'),
  description: text('description'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: inet('ip'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type PhoneNumber = typeof phoneNumbers.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type Call = typeof calls.$inferSelect;
export type CallLeg = typeof callLegs.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
