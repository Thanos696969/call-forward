/**
 * Redis key layout for routing state. Postgres is the source of truth; these
 * keys are a fast, self-healing projection (see reaper.ts and reconcile.ts).
 */
export const keys = {
  /** Compiled route for a dialled number (JSON, 60 s TTL). */
  route: (e164: string) => `route:${e164}`,
  /** Live legs holding a target: ZSET member = holder (`${callSid}:${attempt}`), score = expiry ms. */
  live: (targetId: string) => `ccz:${targetId}`,
  /** Calls sent to a target in a local hour (`YYYYMMDDHH`), 2 h TTL. */
  hour: (targetId: string, hourKey: string) => `cap:h:${targetId}:${hourKey}`,
  /** Calls sent to a target on a local day (`YYYYMMDD`), 3 d TTL. */
  day: (targetId: string, dayKey: string) => `cap:d:${targetId}:${dayKey}`,
  /** Calls ever sent to a target. */
  total: (targetId: string) => `cap:t:${targetId}`,
  /** Recent calls from one caller into one campaign: ZSET member = CallSid, score = ms. */
  callerRate: (campaignId: string, from: string) => `rl:call:${campaignId}:${from}`,
  /** Prefix scanned by the reaper. */
  livePattern: 'ccz:*',
} as const;

export const HOUR_TTL_SEC = 2 * 3600;
export const DAY_TTL_SEC = 3 * 86400;
/** Longest a single answered leg may hold a concurrency slot without a hangup event. */
export const MAX_LEG_SEC = 4 * 3600;

export const holderOf = (providerCallId: string, attempt: number) => `${providerCallId}:${attempt}`;
