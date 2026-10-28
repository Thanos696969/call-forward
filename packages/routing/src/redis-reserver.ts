import type { Redis } from 'ioredis';
import type {
  CapReason,
  ReserveCandidate,
  ReserveRequest,
  ReserveResult,
  Reserver,
} from '@relay/core';
import { DAY_TTL_SEC, HOUR_TTL_SEC, MAX_LEG_SEC, keys } from './keys';

/**
 * One atomic script: prune expired holders, read live counters for every
 * candidate, apply caps, pick (weighted by concurrency headroom) or take all,
 * then record the reservation. Redis runs scripts one at a time, so two calls
 * can never both take the last slot.
 *
 * A holder that already owns a slot on a candidate (a retried webhook) gets
 * the same answer back without counting twice.
 */
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local holder = ARGV[3]
local mode = ARGV[4]
local r = tonumber(ARGV[5])
local n = tonumber(ARGV[6])
local hourTtl = tonumber(ARGV[7])
local dayTtl = tonumber(ARGV[8])
local reasons, usage, weights, mine = {}, {}, {}, {}
local total = 0
local anyMine = false
for i = 1, n do
  local k = (i - 1) * 4
  local a = 8 + (i - 1) * 5
  local w = tonumber(ARGV[a + 1])
  local cap = tonumber(ARGV[a + 2])
  local hcap = tonumber(ARGV[a + 3])
  local dcap = tonumber(ARGV[a + 4])
  local tcap = tonumber(ARGV[a + 5])
  redis.call('ZREMRANGEBYSCORE', KEYS[k + 1], '-inf', now)
  local cc = redis.call('ZCARD', KEYS[k + 1])
  local h = tonumber(redis.call('GET', KEYS[k + 2]) or '0')
  local d = tonumber(redis.call('GET', KEYS[k + 3]) or '0')
  local t = tonumber(redis.call('GET', KEYS[k + 4]) or '0')
  usage[i] = { cc, h, d, t }
  local reason = ''
  if redis.call('ZSCORE', KEYS[k + 1], holder) then
    mine[i] = true
    anyMine = true
  elseif cc >= cap then reason = 'cc_cap'
  elseif hcap >= 0 and h >= hcap then reason = 'hourly_cap'
  elseif dcap >= 0 and d >= dcap then reason = 'daily_cap'
  elseif tcap >= 0 and t >= tcap then reason = 'total_cap'
  end
  reasons[i] = reason
  if reason == '' and not mine[i] then
    weights[i] = w * (cap - cc) / cap
    total = total + weights[i]
  else
    weights[i] = 0
  end
end
local picked = {}
if anyMine then
  for i = 1, n do if mine[i] then table.insert(picked, i) end end
else
  if mode == 'all' then
    for i = 1, n do if reasons[i] == '' and weights[i] > 0 then table.insert(picked, i) end end
  elseif total > 0 then
    local point = r * total
    local chosen = 0
    for i = 1, n do
      if weights[i] > 0 then
        chosen = i
        if point < weights[i] then break end
        point = point - weights[i]
      end
    end
    if chosen > 0 then table.insert(picked, chosen) end
  end
  for _, i in ipairs(picked) do
    local k = (i - 1) * 4
    redis.call('ZADD', KEYS[k + 1], expiry, holder)
    redis.call('PEXPIRE', KEYS[k + 1], ${MAX_LEG_SEC * 1000} + 60000)
    redis.call('INCR', KEYS[k + 2])
    redis.call('EXPIRE', KEYS[k + 2], hourTtl)
    redis.call('INCR', KEYS[k + 3])
    redis.call('EXPIRE', KEYS[k + 3], dayTtl)
    redis.call('INCR', KEYS[k + 4])
  end
end
local out = { #picked }
for _, i in ipairs(picked) do table.insert(out, i) end
for i = 1, n do
  table.insert(out, reasons[i])
  for _, v in ipairs(usage[i]) do table.insert(out, v) end
end
return out
`;

/** Push a holder's expiry out (leg answered). Only touches existing holders. */
const EXTEND_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`;

type ReserveFn = (
  numKeys: number,
  ...args: Array<string | number>
) => Promise<Array<string | number>>;
type ExtendFn = (key: string, holder: string, expiry: number, keyTtlMs: number) => Promise<number>;

declare module 'ioredis' {
  interface RedisCommander {
    relayReserve: ReserveFn;
    relayExtend: ExtendFn;
  }
}

export function installRoutingScripts(redis: Redis): void {
  if (typeof redis.relayReserve === 'function') return;
  redis.defineCommand('relayReserve', { lua: RESERVE_LUA });
  redis.defineCommand('relayExtend', { lua: EXTEND_LUA, numberOfKeys: 1 });
}

const cap = (v: number | null) => (v === null ? -1 : v);

export class RedisReserver implements Reserver {
  readonly name = 'redis';

  constructor(private readonly redis: Redis) {
    installRoutingScripts(redis);
  }

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const n = req.candidates.length;
    const ks: string[] = [];
    const args: Array<string | number> = [
      req.now.getTime(),
      req.now.getTime() + req.ttlSec * 1000,
      req.holder,
      req.mode === 'simultaneous' ? 'all' : 'one',
      req.random,
      n,
      HOUR_TTL_SEC,
      DAY_TTL_SEC,
    ];
    for (const c of req.candidates) {
      const t = c.target;
      ks.push(
        keys.live(t.id),
        keys.hour(t.id, c.hourKey),
        keys.day(t.id, c.dayKey),
        keys.total(t.id),
      );
      args.push(t.weight, t.ccCap, cap(t.hourlyCap), cap(t.dailyCap), cap(t.totalCap));
    }
    const out = await this.redis.relayReserve(ks.length, ...ks, ...args);
    return decodeReserve(out, req.candidates);
  }

  /** Free a slot (leg ended). Idempotent. */
  async release(targetId: string, holder: string): Promise<void> {
    await this.redis.zrem(keys.live(targetId), holder);
  }

  /** Keep holding a slot for an answered leg. */
  async extend(targetId: string, holder: string, untilMs: number): Promise<boolean> {
    return (
      (await this.redis.relayExtend(
        keys.live(targetId),
        holder,
        untilMs,
        MAX_LEG_SEC * 1000 + 60_000,
      )) === 1
    );
  }

  /** Read-only usage for dashboards and dry-run explanations. */
  async usage(candidates: ReserveCandidate[], now: Date) {
    const pipe = this.redis.pipeline();
    for (const c of candidates) {
      pipe.zcount(keys.live(c.target.id), `(${now.getTime()}`, '+inf');
      pipe.get(keys.hour(c.target.id, c.hourKey));
      pipe.get(keys.day(c.target.id, c.dayKey));
      pipe.get(keys.total(c.target.id));
    }
    const res = (await pipe.exec()) ?? [];
    const out: Record<string, { concurrent: number; hour: number; day: number; total: number }> =
      {};
    candidates.forEach((c, i) => {
      const v = (j: number) => Number(res[i * 4 + j]?.[1] ?? 0) || 0;
      out[c.target.id] = { concurrent: v(0), hour: v(1), day: v(2), total: v(3) };
    });
    return out;
  }
}

function decodeReserve(out: Array<string | number>, candidates: ReserveCandidate[]): ReserveResult {
  let p = 0;
  const count = Number(out[p++]);
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Number(out[p++]) - 1;
    const c = candidates[idx];
    if (c) picked.push(c.target.id);
  }
  const reasons: ReserveResult['reasons'] = {};
  const usage: ReserveResult['usage'] = {};
  for (const c of candidates) {
    const reason = String(out[p++] ?? '');
    usage[c.target.id] = {
      concurrent: Number(out[p++]),
      hour: Number(out[p++]),
      day: Number(out[p++]),
      total: Number(out[p++]),
    };
    reasons[c.target.id] = reason === '' ? null : (reason as CapReason);
  }
  return { picked, reasons, usage };
}
