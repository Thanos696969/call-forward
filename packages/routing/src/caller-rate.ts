import type { Redis } from 'ioredis';
import { keys } from './keys';

/**
 * Sliding-window per-caller limit for one campaign. Each call is recorded once
 * by its CallSid (ZADD NX), so a retried webhook never counts twice.
 * Returns how many calls the caller made in the last minute and hour, this one included.
 */
export async function recordCallerAttempt(
  redis: Redis,
  campaignId: string,
  from: string,
  callSid: string,
  now: Date,
): Promise<{ lastMinute: number; lastHour: number }> {
  const key = keys.callerRate(campaignId, from);
  const ms = now.getTime();
  const res = await redis
    .multi()
    .zadd(key, 'NX', ms, callSid)
    .zremrangebyscore(key, '-inf', ms - 3_600_000)
    .zcount(key, ms - 60_000, '+inf')
    .zcard(key)
    .expire(key, 3700)
    .exec();
  const num = (i: number) => Number(res?.[i]?.[1] ?? 0);
  return { lastMinute: num(2), lastHour: num(3) };
}

export function callerLimitExceeded(
  counts: { lastMinute: number; lastHour: number },
  limits: { perMinute: number | null; perHour: number | null },
): 'per_minute' | 'per_hour' | null {
  if (limits.perMinute !== null && counts.lastMinute > limits.perMinute) return 'per_minute';
  if (limits.perHour !== null && counts.lastHour > limits.perHour) return 'per_hour';
  return null;
}
