import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import {
  MemoryReserver,
  capWindowKeys,
  planAttempt,
  staticIneligibility,
  type CompiledRoute,
  type CompiledTarget,
  type ReserveCandidate,
  type RoutingMode,
} from '@relay/core';
import { RedisReserver, keys } from '../src';
import { prng, target } from './fixtures';

let redis: Redis;
let reserver: RedisReserver;
const NOW = new Date('2026-10-30T15:00:00Z');

beforeAll(() => {
  redis = new Redis(inject('redisUrl'));
  reserver = new RedisReserver(redis);
});
afterAll(() => redis.disconnect());
beforeEach(async () => {
  await redis.flushdb();
});

const candidate = (t: CompiledTarget, at = NOW): ReserveCandidate => {
  const k = capWindowKeys(t.capTimezone, at);
  return { target: t, hourKey: k.hour, dayKey: k.day };
};

const routeOf = (targets: CompiledTarget[], mode: RoutingMode): CompiledRoute => ({
  version: 2,
  numberId: 'n',
  orgId: 'o',
  orgTimezone: 'UTC',
  e164: '+18005550100',
  orgStatus: 'active',
  campaign: {
    id: 'c',
    name: 'c',
    status: 'active',
    routingMode: mode,
    ringTimeoutSec: 25,
    ivr: { enabled: false, prompt: null, digit: null, randomDigit: false, timeoutSec: 8 },
    protection: { attestationPolicy: 'allow_all', perMinute: null, perHour: null },
    unavailableMessage: null,
  },
  targets,
});

describe('RedisReserver', () => {
  it('lets exactly ccCap of 50 simultaneous reservations through', async () => {
    const t = target({ ccCap: 5 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        reserver.reserve({
          holder: `CA${i}:1`,
          candidates: [candidate(t)],
          mode: 'sequential',
          now: NOW,
          ttlSec: 85,
          random: 0.5,
        }),
      ),
    );
    expect(results.filter((r) => r.picked.length === 1)).toHaveLength(5);
    expect(results.filter((r) => r.reasons[t.id] === 'cc_cap')).toHaveLength(45);
    expect(await redis.zcard(keys.live(t.id))).toBe(5);
    expect(await redis.get(keys.total(t.id))).toBe('5');
  });

  it('enforces hourly, daily and total caps', async () => {
    const hourly = target({ hourlyCap: 2 });
    const daily = target({ dailyCap: 3, hourlyCap: null });
    const total = target({ totalCap: 1 });
    for (const [t, cap, reason] of [
      [hourly, 2, 'hourly_cap'],
      [daily, 3, 'daily_cap'],
      [total, 1, 'total_cap'],
    ] as const) {
      for (let i = 0; i < cap; i++) {
        const r = await reserver.reserve({
          holder: `${t.id}-${i}:1`,
          candidates: [candidate(t)],
          mode: 'sequential',
          now: NOW,
          ttlSec: 1,
          random: 0,
        });
        expect(r.picked).toEqual([t.id]);
        await reserver.release(t.id, `${t.id}-${i}:1`);
      }
      const blocked = await reserver.reserve({
        holder: 'x:1',
        candidates: [candidate(t)],
        mode: 'sequential',
        now: NOW,
        ttlSec: 1,
        random: 0,
      });
      expect(blocked.picked).toEqual([]);
      expect(blocked.reasons[t.id]).toBe(reason);
    }
  });

  it('is idempotent for a retried holder and frees slots on release or expiry', async () => {
    const t = target({ ccCap: 2 });
    const req = {
      holder: 'CA1:1',
      candidates: [candidate(t)],
      mode: 'sequential' as const,
      now: NOW,
      ttlSec: 30,
      random: 0.2,
    };
    expect((await reserver.reserve(req)).picked).toEqual([t.id]);
    expect((await reserver.reserve(req)).picked).toEqual([t.id]);
    expect(await redis.get(keys.total(t.id))).toBe('1');
    expect(await redis.zcard(keys.live(t.id))).toBe(1);

    await reserver.release(t.id, 'CA1:1');
    expect(await redis.zcard(keys.live(t.id))).toBe(0);

    await reserver.reserve({ ...req, holder: 'CA2:1' });
    const later = new Date(NOW.getTime() + 31_000);
    const usage = await reserver.reserve({ ...req, holder: 'CA3:1', now: later });
    expect(usage.usage[t.id]?.concurrent).toBe(0); // CA2 expired before CA3 arrived
    expect(await reserver.extend(t.id, 'CA3:1', later.getTime() + 3_600_000)).toBe(true);
    expect(await reserver.extend(t.id, 'nobody:1', later.getTime())).toBe(false);
  });

  it('reserves every candidate with headroom in simultaneous mode', async () => {
    const a = target({ ccCap: 1 });
    const b = target();
    await reserver.reserve({
      holder: 'CA0:1',
      candidates: [candidate(a)],
      mode: 'sequential',
      now: NOW,
      ttlSec: 60,
      random: 0,
    });
    const r = await reserver.reserve({
      holder: 'CA1:1',
      candidates: [candidate(a), candidate(b)],
      mode: 'simultaneous',
      now: NOW,
      ttlSec: 60,
      random: 0,
    });
    expect(r.picked).toEqual([b.id]);
    expect(r.reasons[a.id]).toBe('cc_cap');
  });

  it('makes exactly the same decisions as the reference MemoryReserver', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.constantFrom<RoutingMode>('sequential', 'simultaneous'),
        async (seed, mode) => {
          await redis.flushdb();
          const rand = prng(seed);
          const targets = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i) =>
            target({
              name: `T${i}`,
              priorityTier: 1 + Math.floor(rand() * 3),
              weight: Math.floor(rand() * 100),
              ccCap: 1 + Math.floor(rand() * 3),
              hourlyCap: rand() < 0.5 ? 1 + Math.floor(rand() * 20) : null,
              totalCap: rand() < 0.3 ? 1 + Math.floor(rand() * 30) : null,
            }),
          );
          const memory = new MemoryReserver();
          const r = routeOf(targets, mode);
          let clock = NOW.getTime();
          for (let call = 0; call < 60; call++) {
            clock += Math.floor(rand() * 20_000);
            const random = rand();
            const opts = {
              tried: new Set<string>(),
              now: new Date(clock),
              holder: `CA${call}:1`,
              random,
            };
            const viaRedis = await planAttempt(r, opts, reserver);
            const viaMemory = await planAttempt(r, opts, memory);
            expect(viaRedis.kind).toBe(viaMemory.kind);
            expect(viaRedis.explanation.map((t) => t.targets.map((x) => x.verdict))).toEqual(
              viaMemory.explanation.map((t) => t.targets.map((x) => x.verdict)),
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('property: caps hold, no target rings twice per call, tiers are respected (real Redis)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.constantFrom<RoutingMode>('sequential', 'simultaneous'),
        async (seed, mode) => {
          await redis.flushdb();
          const rand = prng(seed);
          const targets = Array.from({ length: 2 + Math.floor(rand() * 5) }, (_, i) =>
            target({
              name: `T${i}`,
              priorityTier: 1 + Math.floor(rand() * 3),
              weight: Math.floor(rand() * 100),
              enabled: rand() < 0.85,
              ccCap: 1 + Math.floor(rand() * 4),
              hourlyCap: rand() < 0.4 ? 1 + Math.floor(rand() * 25) : null,
              dailyCap: rand() < 0.3 ? 1 + Math.floor(rand() * 40) : null,
              totalCap: rand() < 0.3 ? 1 + Math.floor(rand() * 60) : null,
            }),
          );
          const r = routeOf(targets, mode);
          const open: Array<{ t: string; holder: string; until: number }> = [];
          let clock = NOW.getTime();
          for (let call = 0; call < 100; call++) {
            clock += Math.floor(rand() * 40_000);
            const now = new Date(clock);
            for (let i = open.length - 1; i >= 0; i--) {
              if (open[i]!.until <= clock) {
                await reserver.release(open[i]!.t, open[i]!.holder);
                open.splice(i, 1);
              }
            }
            const tried = new Set<string>();
            for (let attempt = 1; attempt <= targets.length; attempt++) {
              const holder = `CA${call}:${attempt}`;
              const before = await reserver.usage(
                targets.map((t) => candidate(t, now)),
                now,
              );
              const ok = (t: CompiledTarget) => {
                if (staticIneligibility(t, tried, now)) return false;
                const u = before[t.id]!;
                return (
                  u.concurrent < t.ccCap &&
                  (t.hourlyCap === null || u.hour < t.hourlyCap) &&
                  (t.dailyCap === null || u.day < t.dailyCap) &&
                  (t.totalCap === null || u.total < t.totalCap)
                );
              };
              const expectedTier = Math.min(
                Infinity,
                ...targets.filter(ok).map((t) => t.priorityTier),
              );
              const plan = await planAttempt(r, { tried, now, holder, random: rand() }, reserver);
              if (plan.kind === 'exhausted') {
                expect(expectedTier).toBe(Infinity);
                break;
              }
              expect(plan.tier).toBe(expectedTier);
              for (const t of plan.targets) {
                expect(tried.has(t.id)).toBe(false);
                tried.add(t.id);
                open.push({ t: t.id, holder, until: clock + Math.floor(rand() * 150_000) });
              }
              const after = await reserver.usage(
                targets.map((t) => candidate(t, now)),
                now,
              );
              for (const t of targets) {
                const u = after[t.id]!;
                expect(u.concurrent).toBeLessThanOrEqual(t.ccCap);
                if (t.hourlyCap !== null) expect(u.hour).toBeLessThanOrEqual(t.hourlyCap);
                if (t.dailyCap !== null) expect(u.day).toBeLessThanOrEqual(t.dailyCap);
                if (t.totalCap !== null) expect(u.total).toBeLessThanOrEqual(t.totalCap);
              }
              if (rand() < 0.5) break;
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('splits 10,000 calls within ±3 percentage points of the weights (real Redis)', async () => {
    const weights = [50, 30, 15, 5];
    const targets = weights.map((w, i) => target({ name: `T${i}`, weight: w, ccCap: 100 }));
    const r = routeOf(targets, 'sequential');
    const rand = prng(42);
    const hits = new Map<string, number>();
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      const holder = `CA${i}:1`;
      const plan = await planAttempt(
        r,
        { tried: new Set(), now: NOW, holder, random: rand() },
        reserver,
      );
      if (plan.kind !== 'dial') throw new Error('exhausted');
      const id = plan.targets[0]!.id;
      hits.set(id, (hits.get(id) ?? 0) + 1);
      await reserver.release(id, holder);
    }
    targets.forEach((t, i) => {
      expect(Math.abs((hits.get(t.id) ?? 0) / n - weights[i]! / 100)).toBeLessThanOrEqual(0.03);
    });
  });
});
