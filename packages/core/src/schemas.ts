import { z } from 'zod';
import { CALL_OUTCOMES } from './outcome';
import { E164_REGEX, US_TOLL_FREE_PREFIXES } from './e164';

/** Shared request schemas. The API validates with these; the web reuses them for inline form errors. */

export const e164Schema = z
  .string()
  .trim()
  .regex(E164_REGEX, 'Use international format, e.g. +14155550123');

export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(200, 'At most 200 characters');

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);

export const registerBodySchema = z.strictObject({
  orgName: z.string().trim().min(2, 'At least 2 characters').max(100),
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100).optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, 'Required').max(200),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const forgotPasswordBodySchema = z.strictObject({ email: emailSchema });

export const resetPasswordBodySchema = z.strictObject({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const updateOrgBodySchema = z
  .strictObject({
    name: z.string().trim().min(2).max(100).optional(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone').optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, 'Nothing to update');
export type UpdateOrgBody = z.infer<typeof updateOrgBodySchema>;

export const ringTimeoutSchema = z.number().int().min(5).max(120);

export const updateForwardingBodySchema = z.strictObject({
  forwardTo: e164Schema,
  ringTimeoutSec: ringTimeoutSchema.default(25),
  enabled: z.boolean().default(true),
});
export type UpdateForwardingBody = z.infer<typeof updateForwardingBodySchema>;

/** Phase 1 sells US toll-free numbers only (see DECISIONS.md: E911). */
export const availableNumbersQuerySchema = z.strictObject({
  country: z.literal('US').default('US'),
  type: z.literal('toll_free').default('toll_free'),
  prefix: z.enum(US_TOLL_FREE_PREFIXES).optional(),
  contains: z
    .string()
    .regex(/^\d{1,7}$/, 'Up to 7 digits')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AvailableNumbersQuery = z.infer<typeof availableNumbersQuerySchema>;

export const purchaseNumberBodySchema = z.strictObject({ e164: e164Schema });

export const callOutcomeSchema = z.enum(CALL_OUTCOMES);

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');

export const listCallsQuerySchema = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
  outcome: callOutcomeSchema.optional(),
  numberId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;

export const dashboardQuerySchema = z.strictObject({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

// ── Phase 2: routing ──────────────────────────────────────────────────────────

const timezoneSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM (24-hour)');
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalCap = z.number().int().min(1).max(1_000_000).nullable();

export const routingModeSchema = z.enum(['sequential', 'simultaneous']);
export const campaignStatusSchema = z.enum(['active', 'paused', 'archived']);
export const attestationPolicySchema = z.enum([
  'allow_all',
  'block_failed',
  'require_a_or_b',
  'require_a',
]);

export const createCampaignBodySchema = z.strictObject({
  name: z.string().trim().min(1, 'Required').max(100),
  routingMode: routingModeSchema.default('sequential'),
  ringTimeoutSec: ringTimeoutSchema.default(25),
});
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

export const updateCampaignBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    status: campaignStatusSchema.optional(),
    routingMode: routingModeSchema.optional(),
    ringTimeoutSec: ringTimeoutSchema.optional(),
    unavailableMessage: z.string().trim().max(300).nullable().optional(),
    ivr: z
      .strictObject({
        enabled: z.boolean().optional(),
        prompt: z.string().trim().max(300).nullable().optional(),
        digit: z
          .string()
          .regex(/^[0-9]$/, 'One digit, 0–9')
          .nullable()
          .optional(),
        randomDigit: z.boolean().optional(),
        timeoutSec: z.number().int().min(3).max(30).optional(),
      })
      .optional(),
    protection: z
      .strictObject({
        attestationPolicy: attestationPolicySchema.optional(),
        perMinute: z.number().int().min(1).max(1000).nullable().optional(),
        perHour: z.number().int().min(1).max(10_000).nullable().optional(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateCampaignBody = z.infer<typeof updateCampaignBodySchema>;

export const targetBodySchema = z.strictObject({
  name: z.string().trim().min(1, 'Required').max(100),
  destination: e164Schema,
  priorityTier: z.number().int().min(1).max(10).default(1),
  weight: z.number().int().min(0).max(1000).default(100),
  ccCap: z.number().int().min(1).max(1000).default(10),
  hourlyCap: optionalCap.default(null),
  dailyCap: optionalCap.default(null),
  totalCap: optionalCap.default(null),
  enabled: z.boolean().default(true),
});
export type TargetBody = z.infer<typeof targetBodySchema>;

export const updateTargetBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).optional(),
    destination: e164Schema.optional(),
    priorityTier: z.number().int().min(1).max(10).optional(),
    weight: z.number().int().min(0).max(1000).optional(),
    ccCap: z.number().int().min(1).max(1000).optional(),
    hourlyCap: optionalCap.optional(),
    dailyCap: optionalCap.optional(),
    totalCap: optionalCap.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateTargetBody = z.infer<typeof updateTargetBodySchema>;

export const scheduleWindowSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
    open: clockSchema,
    close: clockSchema,
  }),
  z
    .strictObject({
      type: z.literal('date'),
      start: localDateSchema,
      end: localDateSchema,
      kind: z.enum(['open', 'closed']),
      open: clockSchema.nullable().default(null),
      close: clockSchema.nullable().default(null),
    })
    .refine((w) => w.end >= w.start, { message: 'End date is before start date', path: ['end'] })
    .refine((w) => (w.open === null) === (w.close === null), {
      message: 'Give both an opening and a closing time, or neither',
      path: ['close'],
    }),
]);

export const scheduleBodySchema = z.strictObject({
  timezone: timezoneSchema,
  windows: z.array(scheduleWindowSchema).max(60),
});
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

export const attachNumberBodySchema = z.strictObject({ numberId: z.uuid() });

export const blocklistBodySchema = z.strictObject({
  e164: e164Schema,
  reason: z.string().trim().max(200).nullable().default(null),
});

export const explainBodySchema = z.strictObject({
  at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date')
    .optional(),
  triedTargetIds: z.array(z.uuid()).max(50).default([]),
});
