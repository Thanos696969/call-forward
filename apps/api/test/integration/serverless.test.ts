import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseCall } from '@relay/db';
import { keys } from '@relay/routing';
import { createInlineCallJobs } from '../../src/lib/inline-jobs';
import {
  MAINTENANCE_LOCK,
  MaintenanceTicker,
  RECONCILE_MARK,
  runMaintenanceIfDue,
  sweepUnfinalised,
} from '../../src/services/maintenance';
import { startHarness, type Harness } from '../harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ CRON_SECRET: 'cron-secret-for-tests' });
});
afterAll(async () => {
  await h.close();
});

const deps = () => ({ sql: h.deps.sql, db: h.deps.db, redis: h.deps.redis });

async function endedCall(minutesAgo: number): Promise<string> {
  const [org] = await h.deps.sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Sweep', ${`sweep-${Date.now()}-${Math.random()}`})
    returning id`;
  const [call] = await h.deps.sql<{ id: string }[]>`
    insert into calls (org_id, provider, provider_call_id, from_e164, to_e164, outcome, talk_seconds,
                       started_at, ended_at)
    values (${org!.id}, 'mock', ${`CA${Math.random().toString(16).slice(2)}`}, '+13125550187',
            '+18005550100', 'completed', 61,
            now() - make_interval(mins => ${minutesAgo + 1}), now() - make_interval(mins => ${minutesAgo}))
    returning id`;
  return call!.id;
}

const billed = async (id: string) =>
  (
    await h.deps.sql<{ b: number | null }[]>`select billed_seconds as b from calls where id = ${id}`
  )[0]!.b;

describe('inline jobs (Vercel)', () => {
  it('finalises after the response through the deferred task', async () => {
    const id = await endedCall(0);
    const deferred: Promise<unknown>[] = [];
    const jobs = createInlineCallJobs(
      h.deps.db,
      (t) => deferred.push(t),
      () => {},
    );
    await jobs.enqueueFinalise(id, 'completed');
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(await billed(id)).toBe(61);
  });

  it('reports failures instead of throwing into the request', async () => {
    const errors: string[] = [];
    const deferred: Promise<unknown>[] = [];
    const jobs = createInlineCallJobs(
      h.deps.db,
      (t) => deferred.push(t),
      (_err, callId) => errors.push(callId),
    );
    await jobs.enqueueFinalise('not-a-uuid', 'completed');
    await Promise.all(deferred);
    expect(errors).toEqual(['not-a-uuid']);
  });
});

describe('maintenance without a worker', () => {
  it('sweeps calls that ended but were never finalised, leaving recent ones alone', async () => {
    const old = await endedCall(5);
    const fresh = await endedCall(0);
    expect(await sweepUnfinalised(deps())).toBeGreaterThanOrEqual(1);
    expect(await billed(old)).toBe(61);
    expect(await billed(fresh)).toBeNull();
    await finaliseCall(h.deps.db, fresh);
  });

  it('runs once per interval across instances and reaps expired holders', async () => {
    await h.deps.redis.del(MAINTENANCE_LOCK, RECONCILE_MARK);
    const target = '00000000-0000-4000-8000-00000000abcd';
    await h.deps.redis.zadd(keys.live(target), Date.now() - 1000, 'CAexpired:1');
    const first = await runMaintenanceIfDue(deps());
    expect(first.ran).toBe(true);
    expect(first.reconcile).toBeDefined();
    expect(await h.deps.redis.zcard(keys.live(target))).toBe(0);
    // A second instance inside the same interval does nothing.
    expect((await runMaintenanceIfDue(deps())).ran).toBe(false);
  });

  it('throttles each instance locally before touching Redis', async () => {
    let now = 1_000_000;
    const ticker = new MaintenanceTicker(deps(), () => now);
    const a = ticker.maybeRun();
    expect(a).not.toBeNull();
    await a;
    now += 1_000;
    expect(ticker.maybeRun()).toBeNull();
    now += 30_000;
    const b = ticker.maybeRun();
    expect(b).not.toBeNull();
    await b;
  });
});

describe('cron endpoint', () => {
  it('requires the Vercel cron secret', async () => {
    const none = await h.app.inject({ method: 'GET', url: '/api/cron/maintenance' });
    expect(none.statusCode).toBe(401);
    const wrong = await h.app.inject({
      method: 'GET',
      url: '/api/cron/maintenance',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    await h.deps.redis.del(MAINTENANCE_LOCK, RECONCILE_MARK);
    const ok = await h.app.inject({
      method: 'GET',
      url: '/api/cron/maintenance',
      headers: { authorization: 'Bearer cron-secret-for-tests' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { data: { ran: boolean } }).data.ran).toBe(true);
  });

  it('is not served at all without a configured secret', async () => {
    const plain = await startHarness();
    try {
      const res = await plain.app.inject({ method: 'GET', url: '/api/cron/maintenance' });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
