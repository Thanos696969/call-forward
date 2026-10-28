import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, memberships, users } from '@relay/db';
import {
  Client,
  buyNumber,
  json,
  newCallSid,
  signUp,
  startHarness,
  uniqueEmail,
  voice,
  type Harness,
} from '../harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe('tenant isolation', () => {
  it('another organisation cannot read, change or release your numbers and calls', async () => {
    const a = await signUp(h.app, 'Org A');
    const b = await signUp(h.app, 'Org B');
    const number = await buyNumber(a.client, '844');
    await a.client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550123' });
    const sid = newCallSid();
    await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: number.e164 });
    const callId = json<{ data: Array<{ id: string }> }>(await a.client.get('/api/v1/calls'))
      .data[0]?.id;
    expect(callId).toBeTruthy();

    expect((await b.client.get(`/api/v1/numbers/${number.id}`)).statusCode).toBe(404);
    expect(
      (await b.client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550000' }))
        .statusCode,
    ).toBe(404);
    expect((await b.client.del(`/api/v1/numbers/${number.id}`)).statusCode).toBe(404);
    expect((await b.client.get(`/api/v1/calls/${callId}`)).statusCode).toBe(404);
    expect(json<{ data: unknown[] }>(await b.client.get('/api/v1/numbers')).data).toHaveLength(0);
    expect(json<{ data: unknown[] }>(await b.client.get('/api/v1/calls')).data).toHaveLength(0);
    expect(
      json<{ data: unknown[] }>(await b.client.get(`/api/v1/calls?numberId=${number.id}`)).data,
    ).toHaveLength(0);
    expect(
      json<{ data: { calls: number } }>(await b.client.get('/api/v1/dashboard/summary')).data.calls,
    ).toBe(0);
    const bAudit = json<{ data: Array<{ entityId: string | null }> }>(
      await b.client.get('/api/v1/audit-logs'),
    ).data;
    expect(bAudit.some((l) => l.entityId === number.id)).toBe(false);

    // A's data is untouched.
    const still = json<{ data: { forwarding: { forwardTo: string } } }>(
      await a.client.get(`/api/v1/numbers/${number.id}`),
    );
    expect(still.data.forwarding.forwardTo).toBe('+14155550123');
  });

  it('malformed ids are 404, not 500', async () => {
    const a = await signUp(h.app);
    expect((await a.client.get('/api/v1/numbers/not-a-uuid')).statusCode).toBe(404);
    expect((await a.client.get('/api/v1/calls/123')).statusCode).toBe(404);
  });

  it('requires a session for every /api/v1 resource', async () => {
    const anon = new Client(h.app);
    for (const url of [
      '/api/v1/me',
      '/api/v1/org',
      '/api/v1/numbers',
      '/api/v1/calls',
      '/api/v1/dashboard/summary',
      '/api/v1/audit-logs',
    ]) {
      expect((await anon.get(url)).statusCode, url).toBe(401);
    }
  });
});

describe('roles', () => {
  it('members can read numbers but not buy, change or release them', async () => {
    const owner = await signUp(h.app, 'Roles Co');
    const number = await buyNumber(owner.client, '888');
    const email = uniqueEmail('member');
    const password = 'member-password-1';
    const [u] = await h.deps.db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(password) })
      .returning();
    await h.deps.db
      .insert(memberships)
      .values({ orgId: owner.orgId, userId: u!.id, role: 'member' });

    const member = new Client(h.app);
    expect((await member.post('/api/v1/auth/login', { email, password })).statusCode).toBe(200);
    expect((await member.get('/api/v1/numbers')).statusCode).toBe(200);
    expect((await member.get(`/api/v1/numbers/${number.id}`)).statusCode).toBe(200);
    expect((await member.post('/api/v1/numbers', { e164: '+18885550119' })).statusCode).toBe(403);
    expect(
      (await member.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550123' }))
        .statusCode,
    ).toBe(403);
    expect((await member.del(`/api/v1/numbers/${number.id}`)).statusCode).toBe(403);
    expect((await member.patch('/api/v1/org', { name: 'Hijack' })).statusCode).toBe(403);
    expect((await member.get('/api/v1/audit-logs')).statusCode).toBe(403);
    expect((await member.get('/api/v1/org/members')).statusCode).toBe(403);
  });
});
