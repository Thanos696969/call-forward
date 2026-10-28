import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { capWindowKeys } from '@relay/core';
import { createDb, type DbHandle } from '@relay/db';
import {
  RedisReserver,
  keys,
  reapOrphans,
  reconcileRouting,
  recordCallerAttempt,
  callerLimitExceeded,
} from '../src';
import { seedCall, seedCampaign, target } from './fixtures';

let db: DbHandle;
let redis: Redis;
beforeAll(() => {
  db = createDb(inject('databaseUrl'), { max: 5 });
  redis = new Redis(inject('redisUrl'));
});
afterAll(async () => {
  redis.disconnect();
  await db.close();
});

describe('orphan reaper', () => {
  it('closes legs that outlived their ring time and releases their slots', async () => {
    await redis.flushdb();
    const t = target();
    const { orgId, campaignId } = await seedCampaign(db.sql, [t]);
    const { callId, callSid } = await seedCall(db.sql, orgId, campaignId);
    const reserver = new RedisReserver(redis);
    const k = capWindowKeys('UTC', new Date());
    await reserver.reserve({
      holder: `${callSid}:1`,
      candidates: [{ target: t, hourKey: k.hour, dayKey: k.day }],
      mode: 'sequential',
      now: new Date(),
      ttlSec: 3600,
      random: 0,
    });
    await db.sql`insert into call_legs (call_id, target_id, attempt, started_at) values (${callId}, ${t.id}, 1, now() - interval '10 minutes')`;
    expect(await redis.zcard(keys.live(t.id))).toBe(1);

    const res = await reapOrphans(db.sql, redis);
    expect(res.closedLegs).toBeGreaterThanOrEqual(1);
    expect(await redis.zcard(keys.live(t.id))).toBe(0);
    const [leg] = await db.sql<
      { outcome: string; released_at: Date | null }[]
    >`select outcome, released_at from call_legs where call_id = ${callId}`;
    expect(leg).toMatchObject({ outcome: 'failed' });
    expect(leg?.released_at).toBeInstanceOf(Date);
  });

  it('fails calls stuck in progress for over four hours', async () => {
    const t = target();
    const { orgId, campaignId } = await seedCampaign(db.sql, [t]);
    const { callId } = await seedCall(db.sql, orgId, campaignId);
    await db.sql`update calls set started_at = now() - interval '5 hours' where id = ${callId}`;
    await reapOrphans(db.sql, redis);
    const [call] = await db.sql<
      { outcome: string }[]
    >`select outcome from calls where id = ${callId}`;
    expect(call?.outcome).toBe('failed');
  });
});

describe('reconciliation', () => {
  it('rebuilds live slots and counters after Redis loses its data, and never lowers counters', async () => {
    const t = target();
    const { orgId, campaignId } = await seedCampaign(db.sql, [t]);
    const open = await seedCall(db.sql, orgId, campaignId);
    const done = await seedCall(db.sql, orgId, campaignId);
    await db.sql`insert into call_legs (call_id, target_id, attempt) values (${open.callId}, ${t.id}, 1)`;
    await db.sql`insert into call_legs (call_id, target_id, attempt, ended_at, released_at) values (${done.callId}, ${t.id}, 1, now(), now())`;

    await redis.flushdb();
    await redis.zadd(keys.live(t.id), Date.now() + 60_000, `${done.callSid}:1`); // stale holder
    const res = await reconcileRouting(db.sql, redis);
    expect(res.restoredHolders).toBeGreaterThanOrEqual(1);
    expect(await redis.zrange(keys.live(t.id), 0, -1)).toEqual([`${open.callSid}:1`]);
    // Seeded organisations use the default America/New_York timezone for cap windows.
    const k = capWindowKeys('America/New_York', new Date());
    expect(await redis.get(keys.total(t.id))).toBe('2');
    expect(await redis.get(keys.hour(t.id, k.hour))).toBe('2');

    await redis.set(keys.total(t.id), '9');
    await reconcileRouting(db.sql, redis);
    expect(await redis.get(keys.total(t.id))).toBe('9');
  });
});

describe('per-caller rate limit', () => {
  it('counts each CallSid once in sliding minute and hour windows', async () => {
    await redis.flushdb();
    const now = new Date('2026-10-30T15:00:00Z');
    const a = await recordCallerAttempt(redis, 'c1', '+13125550100', 'CA1', now);
    const again = await recordCallerAttempt(redis, 'c1', '+13125550100', 'CA1', now);
    expect(a).toEqual({ lastMinute: 1, lastHour: 1 });
    expect(again).toEqual({ lastMinute: 1, lastHour: 1 });
    const b = await recordCallerAttempt(
      redis,
      'c1',
      '+13125550100',
      'CA2',
      new Date(now.getTime() + 61_000),
    );
    expect(b).toEqual({ lastMinute: 1, lastHour: 2 });
    expect(callerLimitExceeded(b, { perMinute: 1, perHour: 1 })).toBe('per_hour');
    expect(callerLimitExceeded(b, { perMinute: null, perHour: 5 })).toBeNull();
  });
});
