import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buyNumber, json, newCallSid, signUp, startHarness, voice, type Harness } from '../harness';

let h: Harness;
let numberE164: string;
let client: Awaited<ReturnType<typeof signUp>>['client'];

beforeAll(async () => {
  h = await startHarness();
  ({ client } = await signUp(h.app, 'Voice Co'));
  const n = await buyNumber(client, '877');
  numberE164 = n.e164;
  await client.patch(`/api/v1/numbers/${n.id}`, { forwardTo: '+14155550123', ringTimeoutSec: 30 });
});
afterAll(async () => {
  await h.close();
});

async function counts(callSid: string) {
  const [row] = await h.deps.sql<{ calls: number; legs: number }[]>`
    select (select count(*)::int from calls where provider_call_id = ${callSid}) as calls,
           (select count(*)::int from call_legs l join calls c on c.id = l.call_id
             where c.provider_call_id = ${callSid}) as legs`;
  return row;
}

describe('voice webhooks', () => {
  it('rejects bad signatures and replays with 403', async () => {
    const params = { CallSid: newCallSid(), From: '+13125550100', To: numberE164 };
    expect((await voice(h.app, '/voice/inbound', params, { secret: 'wrong' })).statusCode).toBe(
      403,
    );
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await voice(h.app, '/voice/inbound', params, { timestampSec: stale })).statusCode).toBe(
      403,
    );
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/voice/inbound',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(params).toString(),
    });
    expect(unsigned.statusCode).toBe(403);
    expect(await counts(params.CallSid)).toEqual({ calls: 0, legs: 0 });
  });

  it('answers unknown numbers with "not in service"', async () => {
    const res = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+1312',
      To: '+18889999999',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('This number is not in service.');
  });

  it('is idempotent: duplicate inbound and result webhooks never duplicate calls or legs', async () => {
    const sid = newCallSid();
    const params = { CallSid: sid, From: '+13125550100', To: numberE164 };
    const first = await voice(h.app, '/voice/inbound', params);
    const second = await voice(h.app, '/voice/inbound', params);
    expect(second.body).toBe(first.body);
    expect(await counts(sid)).toEqual({ calls: 1, legs: 1 });

    const before = h.jobs.enqueued.length;
    const result = { CallSid: sid, DialCallStatus: 'completed', DialCallDuration: '30' };
    expect((await voice(h.app, '/voice/result', result)).statusCode).toBe(200);
    expect((await voice(h.app, '/voice/result', result)).statusCode).toBe(200);
    // A late retry with a different status must not overwrite the first result.
    await voice(h.app, '/voice/result', { ...result, DialCallStatus: 'busy' });
    expect(h.jobs.enqueued.length - before).toBe(1);
    expect(await counts(sid)).toEqual({ calls: 1, legs: 1 });

    const [row] = await h.deps.sql<{ outcome: string; talk_seconds: number }[]>`
      select outcome, talk_seconds from calls where provider_call_id = ${sid}`;
    expect(row).toEqual({ outcome: 'completed', talk_seconds: 30 });
  });

  it('maps every dial status to an outcome', async () => {
    const expected: Record<string, string> = {
      completed: 'completed',
      'no-answer': 'no_answer',
      busy: 'busy',
      failed: 'failed',
      canceled: 'abandoned',
    };
    for (const [status, outcome] of Object.entries(expected)) {
      const sid = newCallSid();
      await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: numberE164 });
      await voice(h.app, '/voice/result', {
        CallSid: sid,
        DialCallStatus: status,
        DialCallDuration: '9',
      });
      const [row] = await h.deps.sql<{ outcome: string; talk_seconds: number }[]>`
        select outcome, talk_seconds from calls where provider_call_id = ${sid}`;
      expect(row?.outcome).toBe(outcome);
      expect(row?.talk_seconds).toBe(status === 'completed' ? 9 : 0);
    }
  });

  it('status callbacks are monotonic and never regress a completed call', async () => {
    const sid = newCallSid();
    await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: numberE164 });
    await voice(h.app, '/voice/result', {
      CallSid: sid,
      DialCallStatus: 'completed',
      DialCallDuration: '12',
    });
    expect(
      (await voice(h.app, '/voice/status', { CallSid: sid, CallStatus: 'completed' })).statusCode,
    ).toBe(204);
    // Out-of-order "ringing" after completion must be ignored.
    await voice(h.app, '/voice/status', { CallSid: sid, CallStatus: 'ringing' });
    const [row] = await h.deps.sql<
      { outcome: string; ended_at: Date | null; status_rank: string }[]
    >`
      select outcome, ended_at, metadata->>'statusRank' as status_rank from calls where provider_call_id = ${sid}`;
    expect(row?.outcome).toBe('completed');
    expect(row?.ended_at).toBeInstanceOf(Date);
    expect(row?.status_rank).toBe('4');
  });

  it('a caller hanging up before the dial result is recorded, then corrected by the dial result', async () => {
    const sid = newCallSid();
    await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: numberE164 });
    await voice(h.app, '/voice/status', { CallSid: sid, CallStatus: 'completed' });
    let [row] = await h.deps.sql<
      { outcome: string }[]
    >`select outcome from calls where provider_call_id = ${sid}`;
    expect(row?.outcome).toBe('abandoned');
    await voice(h.app, '/voice/result', { CallSid: sid, DialCallStatus: 'no-answer' });
    [row] = await h.deps.sql<
      { outcome: string }[]
    >`select outcome from calls where provider_call_id = ${sid}`;
    expect(row?.outcome).toBe('no_answer');
  });

  it('serves inbound calls from Postgres when the route cache misses', async () => {
    await h.deps.redis.del(`route:${numberE164}`);
    const res = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: numberE164,
    });
    expect(res.body).toContain('<Dial timeout="30"');
    expect(await h.deps.redis.get(`route:${numberE164}`)).toContain('+14155550123');
  });

  it('invalidates the route cache when forwarding changes', async () => {
    const numbers = json<{ data: Array<{ id: string }> }>(await client.get('/api/v1/numbers')).data;
    await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: numberE164,
    });
    await client.patch(`/api/v1/numbers/${numbers[0]?.id}`, {
      forwardTo: '+14155550199',
      ringTimeoutSec: 30,
    });
    const res = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: numberE164,
    });
    expect(res.body).toContain('>+14155550199</Number>');
  });
});
