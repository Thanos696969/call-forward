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
