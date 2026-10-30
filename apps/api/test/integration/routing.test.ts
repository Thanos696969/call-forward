import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { keys } from '@relay/routing';
import {
  buyNumber,
  newCallSid,
  signUp,
  startHarness,
  voice,
  type Harness,
  PUBLIC_URL,
} from '../harness';
import { parseDial, routeNumber, type CampaignSpec, type TargetSpec } from '../routing-fixtures';

let h: Harness;
let rnd = 0.5;
beforeAll(async () => {
  h = await startHarness({}, { random: () => rnd });
});
afterAll(async () => {
  await h.close();
});

const A = '+14155550101';
const B = '+14155550102';
const C = '+14155550103';
const relative = (url: string) => url.replace(PUBLIC_URL, '');

async function setup(campaign: CampaignSpec, targets: TargetSpec[], prefix = '800') {
  const { client, orgId } = await signUp(h.app, 'Routing Co');
  const number = await buyNumber(client, prefix);
  const routed = await routeNumber(h, orgId, number.id, campaign, targets);
  return { client, orgId, number, ...routed };
}

async function call(e164: string, extra: Record<string, string> = {}) {
  const sid = newCallSid();
  const res = await voice(h.app, '/voice/inbound', {
    CallSid: sid,
    From: '+13125550187',
    To: e164,
    ...extra,
  });
  return { sid, res, dial: parseDial(res.body) };
}

async function result(
  sid: string,
  attempt: number,
  status: string,
  extra: Record<string, string> = {},
) {
  const res = await voice(h.app, `/voice/result?attempt=${attempt}`, {
    CallSid: sid,
    DialCallStatus: status,
    DialCallDuration: status === 'completed' ? '60' : '0',
    ...extra,
  });
  return { res, dial: parseDial(res.body) };
}

async function legs(sid: string) {
  return h.deps.sql<
    { attempt: number; destination: string; outcome: string | null; tier: number }[]
  >`
    select l.attempt, l.destination, l.outcome, l.tier from call_legs l join calls c on c.id = l.call_id
    where c.provider_call_id = ${sid} order by l.attempt, l.destination`;
}

async function callRow(sid: string) {
  const [row] = await h.deps.sql<
    { id: string; outcome: string; hangup_cause: string | null; talk_seconds: number | null }[]
  >`
    select id, outcome, hangup_cause, talk_seconds from calls where provider_call_id = ${sid}`;
  return row!;
}

describe('sequential failover', () => {
  it('fails over through tiers on no-answer and busy, then connects', async () => {
    const { number, targetIds } = await setup({}, [
      { name: 'A', destination: A, tier: 1 },
      { name: 'B', destination: B, tier: 2 },
      { name: 'C', destination: C, tier: 3 },
    ]);
    const first = await call(number.e164);
    expect(first.dial).toMatchObject({ attempt: 1, numbers: [{ destination: A }] });
    expect(first.dial.numbers[0]?.legUrl).toBe(
      `${PUBLIC_URL}/voice/leg?attempt=1&target=${targetIds.A}`,
    );

    const second = await result(first.sid, 1, 'no-answer');
    expect(second.dial).toMatchObject({ attempt: 2, numbers: [{ destination: B }] });
    const third = await result(first.sid, 2, 'busy');
    expect(third.dial).toMatchObject({ attempt: 3, numbers: [{ destination: C }] });
    const done = await result(first.sid, 3, 'completed');
    expect(done.res.body).toContain('<Response/>');

    expect(await legs(first.sid)).toEqual([
      { attempt: 1, destination: A, outcome: 'no_answer', tier: 1 },
      { attempt: 2, destination: B, outcome: 'busy', tier: 2 },
      { attempt: 3, destination: C, outcome: 'completed', tier: 3 },
    ]);
    expect(await callRow(first.sid)).toMatchObject({ outcome: 'completed', talk_seconds: 60 });
    for (const id of Object.values(targetIds))
      expect(await h.deps.redis.zcard(keys.live(id))).toBe(0);
  });

  it('never rings a target twice and ends with the unavailable message', async () => {
    const { number } = await setup({ unavailableMessage: 'Everyone is busy, call back soon.' }, [
      { name: 'A', destination: A },
      { name: 'B', destination: B },
      { name: 'C', destination: C },
    ]);
    const c = await call(number.e164);
    const seen = [c.dial.numbers[0]!.destination];
    let attempt = 1;
    let last = c.dial;
    while (last.action) {
      const r = await result(c.sid, attempt, 'no-answer');
      last = r.dial;
      if (r.dial.action) seen.push(r.dial.numbers[0]!.destination);
      else expect(r.res.body).toContain('<Say>Everyone is busy, call back soon.</Say><Hangup/>');
      attempt++;
    }
    expect(seen.sort()).toEqual([A, B, C]);
    expect(await callRow(c.sid)).toMatchObject({
      outcome: 'no_answer',
      hangup_cause: 'all_targets_tried',
    });
  });

  it('does not fail over when the caller hung up', async () => {
    const { number } = await setup({}, [
      { name: 'A', destination: A },
      { name: 'B', destination: B, tier: 2 },
    ]);
    const c = await call(number.e164);
    const r = await result(c.sid, 1, 'canceled');
    expect(r.res.body).toContain('<Response/>');
    expect(await callRow(c.sid)).toMatchObject({ outcome: 'abandoned' });
    expect(await legs(c.sid)).toHaveLength(1);
  });

  it('is idempotent across retries of every webhook', async () => {
    const { number } = await setup({}, [
      { name: 'A', destination: A },
      { name: 'B', destination: B, tier: 2 },
    ]);
    const c = await call(number.e164);
    const retryInbound = await voice(h.app, '/voice/inbound', {
      CallSid: c.sid,
      From: '+13125550187',
      To: number.e164,
    });
    expect(retryInbound.body).toBe(c.res.body);
    const r1 = await result(c.sid, 1, 'no-answer');
    const r1again = await result(c.sid, 1, 'no-answer');
    expect(r1again.res.body).toBe(r1.res.body);
    expect(await legs(c.sid)).toHaveLength(2);
    const [attempts] = await h.deps.sql<
      { n: number }[]
    >`select count(*)::int as n from call_attempts a join calls c on c.id = a.call_id where c.provider_call_id = ${c.sid}`;
    expect(attempts?.n).toBe(2);
  });
});

describe('simultaneous ringing', () => {
  it('rings the whole tier at once; the leg that answers wins', async () => {
    const { number, targetIds } = await setup({ mode: 'simultaneous' }, [
      { name: 'A', destination: A },
      { name: 'B', destination: B },
      { name: 'C', destination: C, tier: 2 },
    ]);
    const c = await call(number.e164);
    expect(c.dial.numbers.map((n) => n.destination).sort()).toEqual([A, B]);
    const legA = c.dial.numbers.find((n) => n.destination === A)!.legUrl!;
    const legB = c.dial.numbers.find((n) => n.destination === B)!.legUrl!;
    await voice(h.app, relative(legA), {
      CallSid: 'CAlegA',
      ParentCallSid: c.sid,
      CallStatus: 'ringing',
    });
    await voice(h.app, relative(legB), {
      CallSid: 'CAlegB',
      ParentCallSid: c.sid,
      CallStatus: 'ringing',
    });
    await voice(h.app, relative(legB), {
      CallSid: 'CAlegB',
      ParentCallSid: c.sid,
      CallStatus: 'in-progress',
    });
    await voice(h.app, relative(legA), {
      CallSid: 'CAlegA',
      ParentCallSid: c.sid,
      CallStatus: 'canceled',
    });
    expect(await h.deps.redis.zcard(keys.live(targetIds.A!))).toBe(0); // A freed as soon as it was cancelled
    expect(await h.deps.redis.zcard(keys.live(targetIds.B!))).toBe(1); // B held while talking
    await result(c.sid, 1, 'completed', { DialCallSid: 'CAlegB' });
    expect(await legs(c.sid)).toEqual([
      { attempt: 1, destination: A, outcome: 'no_answer', tier: 1 },
      { attempt: 1, destination: B, outcome: 'completed', tier: 1 },
    ]);
    const [row] = await h.deps.sql<
      { destination: string }[]
    >`select t.destination from calls c join targets t on t.id = c.target_id where c.provider_call_id = ${c.sid}`;
    expect(row?.destination).toBe(B);
    expect(await h.deps.redis.zcard(keys.live(targetIds.B!))).toBe(0);
  });
});

describe('capacity and schedules', () => {
  it('skips a target at its concurrent cap and returns to it once the call ends', async () => {
    const { number } = await setup({}, [
      { name: 'A', destination: A, ccCap: 1 },
      { name: 'B', destination: B, tier: 2 },
    ]);
    const first = await call(number.e164);
    expect(first.dial.numbers[0]?.destination).toBe(A);
    const second = await call(number.e164);
    expect(second.dial.numbers[0]?.destination).toBe(B);
    await result(first.sid, 1, 'completed');
    const third = await call(number.e164);
    expect(third.dial.numbers[0]?.destination).toBe(A);

    const [ev] = await h.deps.sql<
      { detail: { tiers: Array<{ tier: number; targets: Array<{ verdict: string }> }> } }[]
    >`
      select e.detail from call_routing_events e join calls c on c.id = e.call_id
      where c.provider_call_id = ${second.sid} and e.kind = 'attempt'`;
    expect(ev?.detail.tiers[0]?.targets[0]?.verdict).toBe('cc_cap');
  });

  it('honours hourly caps and target schedules', async () => {
    const { number } = await setup({}, [
      {
        name: 'Closed',
        destination: C,
        schedule: {
          timezone: 'UTC',
          windows: [{ dateStart: '2000-01-01', dateEnd: '2100-01-01', kind: 'closed' }],
        },
      },
      { name: 'A', destination: A, hourlyCap: 1 },
      { name: 'B', destination: B, tier: 2 },
    ]);
    const first = await call(number.e164);
    expect(first.dial.numbers[0]?.destination).toBe(A);
    await result(first.sid, 1, 'completed');
    const second = await call(number.e164);
    expect(second.dial.numbers[0]?.destination).toBe(B);
    const [ev] = await h.deps.sql<
      { detail: { tiers: Array<{ targets: Array<{ name: string; verdict: string }> }> } }[]
    >`
      select e.detail from call_routing_events e join calls c on c.id = e.call_id where c.provider_call_id = ${second.sid} and e.kind = 'attempt'`;
    expect(ev?.detail.tiers[0]?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Closed', verdict: 'outside_schedule' }),
        expect.objectContaining({ name: 'A', verdict: 'hourly_cap' }),
      ]),
    );
  });

  it('says "not configured" with no usable targets, and "unavailable" when all are busy', async () => {
    const off = await setup({}, [{ name: 'A', destination: A, enabled: false }]);
    expect((await call(off.number.e164)).res.body).toContain('This number is not configured.');
    const full = await setup({}, [{ name: 'A', destination: A, totalCap: 1 }]);
    await call(full.number.e164);
    const r = await call(full.number.e164);
    expect(r.res.body).toContain('nobody is available');
    expect(await callRow(r.sid)).toMatchObject({
      outcome: 'rejected',
      hangup_cause: 'no_eligible_target',
    });
  });

  it('frees ringing slots when the caller hangs up', async () => {
    const { number, targetIds } = await setup({}, [{ name: 'A', destination: A }]);
    const c = await call(number.e164);
    expect(await h.deps.redis.zcard(keys.live(targetIds.A!))).toBe(1);
    await voice(h.app, '/voice/status', { CallSid: c.sid, CallStatus: 'completed' });
    expect(await h.deps.redis.zcard(keys.live(targetIds.A!))).toBe(0);
    expect(await callRow(c.sid)).toMatchObject({ outcome: 'abandoned' });
  });
});

describe('press-a-digit IVR', () => {
  it('connects only after the right digit', async () => {
    const { number } = await setup({ ivr: { prompt: 'Press {digit} for sales.', digit: '3' } }, [
      { name: 'A', destination: A },
    ]);
    const c = await call(number.e164);
    expect(c.res.body).toContain('<Gather numDigits="1"');
    expect(c.res.body).toContain('<Say>Press 3 for sales.</Say>');
    const ok = await voice(h.app, '/voice/ivr', { CallSid: c.sid, Digits: '3' });
    expect(parseDial(ok.body).numbers[0]?.destination).toBe(A);

    const wrong = await call(number.e164);
    const bad = await voice(h.app, '/voice/ivr', { CallSid: wrong.sid, Digits: '9' });
    expect(bad.body).toContain('That was not the right key');
    expect(await callRow(wrong.sid)).toMatchObject({
      outcome: 'screened_out',
      hangup_cause: 'ivr_wrong_digit',
    });

    const silent = await call(number.e164);
    await voice(h.app, '/voice/ivr', { CallSid: silent.sid, Digits: '' });
    expect(await callRow(silent.sid)).toMatchObject({
      outcome: 'screened_out',
      hangup_cause: 'ivr_no_input',
    });
  });

  it('uses a random digit per call when configured', async () => {
    const { number } = await setup({ ivr: { random: true } }, [{ name: 'A', destination: A }]);
    rnd = 0.95; // → digit 9
    const c = await call(number.e164);
    rnd = 0.5;
    expect(c.res.body).toContain('press 9');
    expect(
      parseDial((await voice(h.app, '/voice/ivr', { CallSid: c.sid, Digits: '9' })).body).numbers,
    ).toHaveLength(1);
  });
});

describe('call protection', () => {
  it('rejects blocklisted callers without ringing anyone', async () => {
    const { number, orgId } = await setup({}, [{ name: 'A', destination: A }]);
    await h.deps
      .sql`insert into blocklist_entries (org_id, e164, reason) values (${orgId}, '+13125550187', 'spam')`;
    const c = await call(number.e164);
    expect(c.res.body).toContain('<Reject reason="busy"/>');
    expect(await callRow(c.sid)).toMatchObject({ outcome: 'blocked', hangup_cause: 'blocklist' });
    expect(await legs(c.sid)).toHaveLength(0);
  });

  it('enforces the STIR/SHAKEN attestation policy', async () => {
    const { number } = await setup({ attestation: 'require_a' }, [{ name: 'A', destination: A }]);
    const b = await call(number.e164, { StirVerstat: 'TN-Validation-Passed-B' });
    expect(await callRow(b.sid)).toMatchObject({ outcome: 'blocked', hangup_cause: 'attestation' });
    const a = await call(number.e164, { StirVerstat: 'TN-Validation-Passed-A' });
    expect(a.dial.numbers).toHaveLength(1);
  });

  it('rate-limits repeat callers per campaign', async () => {
    const { number } = await setup({ perMinute: 2 }, [{ name: 'A', destination: A, ccCap: 50 }]);
    const outcomes = [];
    for (let i = 0; i < 3; i++)
      outcomes.push((await callRow((await call(number.e164)).sid)).outcome);
    expect(outcomes).toEqual(['in_progress', 'in_progress', 'blocked']);
  });
});

describe('Redis outage', () => {
  it('keeps routing calls through the Postgres fallback', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    dead.on('error', () => {});
    const down = await startHarness({}, { redis: dead, random: () => 0.5 });
    try {
      const { client, orgId } = await signUp(down.app, 'Outage Co');
      const number = await buyNumber(client, '833');
      await routeNumber(down, orgId, number.id, { perMinute: 5 }, [
        { name: 'A', destination: A, ccCap: 1 },
        { name: 'B', destination: B, tier: 2 },
      ]);
      const first = parseDial(
        (
          await voice(down.app, '/voice/inbound', {
            CallSid: newCallSid(),
            From: '+13125550187',
            To: number.e164,
          })
        ).body,
      );
      const second = parseDial(
        (
          await voice(down.app, '/voice/inbound', {
            CallSid: newCallSid(),
            From: '+13125550187',
            To: number.e164,
          })
        ).body,
      );
      expect(first.numbers[0]?.destination).toBe(A);
      expect(second.numbers[0]?.destination).toBe(B); // cap enforced from Postgres
      const [ev] = await down.deps.sql<
        { n: number }[]
      >`select count(*)::int as n from call_routing_events where kind = 'fallback'`;
      expect(ev?.n).toBeGreaterThanOrEqual(2);
    } finally {
      await down.close();
    }
  });
});

describe('end-to-end routing properties', () => {
  it('over 300 calls with random outcomes: caps hold, no double rings, tier order respected', async () => {
    const specs: TargetSpec[] = [
      { name: 'A', destination: A, tier: 1, ccCap: 2, weight: 70 },
      { name: 'B', destination: B, tier: 1, ccCap: 1, weight: 30, hourlyCap: 40 },
      { name: 'C', destination: C, tier: 2, ccCap: 3 },
      { name: 'D', destination: '+14155550104', tier: 3, ccCap: 2 },
    ];
    const { number, targetIds } = await setup({}, specs, '844');
    const caps = Object.fromEntries(specs.map((s) => [targetIds[s.name]!, s.ccCap!]));
    const open: Array<{ sid: string; attempt: number }> = [];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i++) {
      rnd = rand();
      const c = await call(number.e164);
      if (c.dial.attempt) open.push({ sid: c.sid, attempt: c.dial.attempt });
      // Resolve a random subset of open dials with a random outcome (failover may follow).
      for (let j = open.length - 1; j >= 0; j--) {
        if (rand() < 0.45) {
          const o = open.splice(j, 1)[0]!;
          const status = ['completed', 'no-answer', 'busy', 'failed'][Math.floor(rand() * 4)]!;
          const r = await result(o.sid, o.attempt, status);
          if (r.dial.attempt) open.push({ sid: o.sid, attempt: r.dial.attempt });
        }
      }
      for (const [id, cap] of Object.entries(caps)) {
        expect(await h.deps.redis.zcard(keys.live(id))).toBeLessThanOrEqual(cap);
      }
    }
    const dup = await h.deps.sql<{ n: number }[]>`
      select count(*)::int as n from (select l.call_id, l.target_id from call_legs l join calls c on c.id = l.call_id
        where c.to_e164 = ${number.e164} group by 1, 2 having count(*) > 1) d`;
    expect(dup[0]?.n).toBe(0);
    // Tier order: on every attempt, each tier walked before the dialled one had no target that
    // could have been dialled. (Later attempts may go back to a lower tier once it frees up.)
    const events = await h.deps.sql<
      {
        detail: {
          tier: number;
          tiers: Array<{ tier: number; targets: Array<{ verdict: string }> }>;
        };
      }[]
    >`
      select e.detail from call_routing_events e join calls c on c.id = e.call_id
      where c.to_e164 = ${number.e164} and e.kind = 'attempt'`;
    expect(events.length).toBeGreaterThan(300);
    for (const { detail } of events) {
      for (const t of detail.tiers) {
        if (t.tier < detail.tier) {
          for (const x of t.targets) expect(['picked', 'not_picked']).not.toContain(x.verdict);
        }
        if (t.tier === detail.tier)
          expect(t.targets.some((x) => x.verdict === 'picked')).toBe(true);
      }
    }
    const [hourB] = await h.deps.sql<
      { n: number }[]
    >`select count(*)::int as n from call_legs where target_id = ${targetIds.B!}`;
    expect(hourB?.n).toBeLessThanOrEqual(40);
  });
});
