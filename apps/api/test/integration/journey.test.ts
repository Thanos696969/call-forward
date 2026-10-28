import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseCall } from '@relay/db';
import { buyNumber, json, newCallSid, signUp, startHarness, voice, type Harness } from '../harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('Phase 1 journey: register → buy → forward → call → log', () => {
  it('forwards a call and logs it with duration and outcome', async () => {
    const { client } = await signUp(h.app, 'Journey Co');

    const me = await client.get('/api/v1/me');
    expect(me.statusCode).toBe(200);
    expect(json<{ data: { role: string } }>(me).data.role).toBe('owner');

    const number = await buyNumber(client);
    expect(number.e164).toMatch(/^\+1800555\d{4}$/);

    const fwd = await client.patch(`/api/v1/numbers/${number.id}`, {
      forwardTo: '+14155550123',
      ringTimeoutSec: 20,
      enabled: true,
    });
    expect(fwd.statusCode).toBe(200);
    expect(json<{ data: { forwarding: unknown } }>(fwd).data.forwarding).toEqual({
      forwardTo: '+14155550123',
      ringTimeoutSec: 20,
      enabled: true,
    });

    const callSid = newCallSid();
    const inbound = await voice(h.app, '/voice/inbound', {
      CallSid: callSid,
      From: '+13125550187',
      To: number.e164,
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.headers['content-type']).toContain('text/xml');
    expect(inbound.body).toContain('<Dial timeout="20" answerOnBridge="true"');
    expect(inbound.body).toContain(`callerId="${number.e164}"`);
    expect(inbound.body).toContain('action="http://relay.test/voice/result"');
    expect(inbound.body).toContain('<Number>+14155550123</Number>');

    const inFlight = json<{ data: Array<{ outcome: string }> }>(await client.get('/api/v1/calls'));
    expect(inFlight.data[0]?.outcome).toBe('in_progress');

    const result = await voice(h.app, '/voice/result', {
      CallSid: callSid,
      DialCallStatus: 'completed',
      DialCallDuration: '73',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('<Response/>');

    const list = json<{ data: Array<Record<string, unknown>> }>(await client.get('/api/v1/calls'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      from: '+13125550187',
      numberE164: number.e164,
      destination: '+14155550123',
      outcome: 'completed',
      talkSeconds: 73,
    });
    const callId = String(list.data[0]?.id);

    // Worker job (run inline): billed seconds placeholder + audit row.
    expect(h.jobs.enqueued.filter((j) => j.callId === callId)).toHaveLength(1);
    expect(await finaliseCall(h.deps.db, callId)).toBe('finalised');
    expect(await finaliseCall(h.deps.db, callId)).toBe('unchanged');

    const detail = json<{
      data: { billedSeconds: number; legs: Array<{ outcome: string; attempt: number }> };
    }>(await client.get(`/api/v1/calls/${callId}`)).data;
    expect(detail.billedSeconds).toBe(73);
    expect(detail.legs).toEqual([expect.objectContaining({ attempt: 1, outcome: 'completed' })]);

    const summary = json<{ data: Record<string, unknown> }>(
      await client.get('/api/v1/dashboard/summary?days=7'),
    ).data;
    expect(summary).toMatchObject({
      calls: 1,
      answered: 1,
      answerRate: 1,
      minutes: 2,
      completed: 1,
      missed: 0,
    });
    expect(summary.daily).toHaveLength(7);

    const audit = json<{ data: Array<{ action: string }> }>(
      await client.get('/api/v1/audit-logs'),
    ).data.map((a) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        'auth.register',
        'number.purchase',
        'forwarding.update',
        'call.finalised',
      ]),
    );
  });

  it('filters and paginates the call log with a cursor', async () => {
    const { client } = await signUp(h.app);
    const number = await buyNumber(client);
    await client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550123' });
    for (const status of ['completed', 'no-answer', 'busy']) {
      const sid = newCallSid();
      await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: number.e164 });
      await voice(h.app, '/voice/result', {
        CallSid: sid,
        DialCallStatus: status,
        DialCallDuration: '5',
      });
    }
    const page1 = json<{ data: unknown[]; meta: { nextCursor: string } }>(
      await client.get('/api/v1/calls?limit=2'),
    );
    expect(page1.data).toHaveLength(2);
    expect(page1.meta.nextCursor).toBeTruthy();
    const page2 = json<{ data: unknown[]; meta: { nextCursor: string | null } }>(
      await client.get(`/api/v1/calls?limit=2&cursor=${page1.meta.nextCursor}`),
    );
    expect(page2.data).toHaveLength(1);
    expect(page2.meta.nextCursor).toBeNull();

    const busy = json<{ data: Array<{ outcome: string }> }>(
      await client.get('/api/v1/calls?outcome=busy'),
    );
    expect(busy.data.map((c) => c.outcome)).toEqual(['busy']);
    const byNumber = json<{ data: unknown[] }>(
      await client.get(`/api/v1/calls?numberId=${number.id}`),
    );
    expect(byNumber.data).toHaveLength(3);
    const future = json<{ data: unknown[] }>(
      await client.get('/api/v1/calls?from=2999-01-01T00:00:00Z'),
    );
    expect(future.data).toHaveLength(0);

    const summary = json<{ data: Record<string, number> }>(
      await client.get('/api/v1/dashboard/summary?days=30'),
    ).data;
    expect(summary).toMatchObject({ calls: 3, answered: 1, missed: 2, failed: 0 });
  });

  it('releases a number: calls stop and the number can be bought again', async () => {
    const a = await signUp(h.app);
    const number = await buyNumber(a.client, '866');
    await a.client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550123' });

    const del = await a.client.del(`/api/v1/numbers/${number.id}`);
    expect(del.statusCode).toBe(200);
    expect(json<{ data: { status: string; releasedAt: string } }>(del).data).toMatchObject({
      status: 'released',
    });
    expect(json<{ data: unknown[] }>(await a.client.get('/api/v1/numbers')).data).toHaveLength(0);

    const after = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: number.e164,
    });
    expect(after.body).toContain('<Say>This number is not in service.</Say><Hangup/>');

    const b = await signUp(h.app);
    const rebuy = await b.client.post('/api/v1/numbers', { e164: number.e164 });
    expect(rebuy.statusCode).toBe(201);
  });

  it('turning forwarding off makes callers hear "not configured" and logs the call', async () => {
    const { client } = await signUp(h.app);
    const number = await buyNumber(client);

    const unconfigured = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: number.e164,
    });
    expect(unconfigured.body).toContain('<Say>This number is not configured.</Say><Hangup/>');

    await client.patch(`/api/v1/numbers/${number.id}`, {
      forwardTo: '+14155550123',
      enabled: false,
    });
    const off = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: number.e164,
    });
    expect(off.body).toContain('not configured');

    const calls = json<{ data: Array<{ outcome: string }> }>(
      await client.get('/api/v1/calls'),
    ).data;
    expect(calls.map((c) => c.outcome)).toEqual(['rejected', 'rejected']);
  });

  it('rejects purchases of numbers already owned, local numbers and junk input', async () => {
    const a = await signUp(h.app);
    const number = await buyNumber(a.client, '855');
    const b = await signUp(h.app);
    const dup = await b.client.post('/api/v1/numbers', { e164: number.e164 });
    expect(dup.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(dup).error.code).toBe('number_unavailable');

    expect((await b.client.post('/api/v1/numbers', { e164: '+14155550123' })).statusCode).toBe(422);
    expect((await b.client.post('/api/v1/numbers', { e164: 'nope' })).statusCode).toBe(422);
    expect((await b.client.get('/api/v1/numbers/available?type=local')).statusCode).toBe(422);
  });
});
