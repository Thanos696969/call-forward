import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, memberships, users } from '@relay/db';
import type { CampaignDto, ExplainDto, LiveCallDto } from '@relay/core';
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
  PUBLIC_URL,
} from '../harness';
import { parseDial } from '../routing-fixtures';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({}, { random: () => 0.1 });
});
afterAll(async () => {
  await h.close();
});

type Env<T> = { data: T };
const data = <T>(res: { json: () => unknown }) => (res.json() as Env<T>).data;

async function newCampaign(client: Client, name = 'Sales') {
  const res = await client.post('/api/v1/campaigns', {
    name,
    routingMode: 'sequential',
    ringTimeoutSec: 20,
  });
  expect(res.statusCode).toBe(201);
  return data<CampaignDto>(res);
}

async function addTarget(client: Client, campaignId: string, body: Record<string, unknown>) {
  const res = await client.post(`/api/v1/campaigns/${campaignId}/targets`, {
    name: 'Desk',
    destination: '+14155550101',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return data<CampaignDto>(res);
}

async function memberOf(orgId: string) {
  const email = uniqueEmail('member');
  const [u] = await h.deps.db
    .insert(users)
    .values({ email, passwordHash: await hashPassword('member-password-1') })
    .returning();
  await h.deps.db.insert(memberships).values({ orgId, userId: u!.id, role: 'member' });
  const c = new Client(h.app);
  expect(
    (await c.post('/api/v1/auth/login', { email, password: 'member-password-1' })).statusCode,
  ).toBe(200);
  return c;
}

describe('campaigns', () => {
  it('creates, lists, updates, archives and restores a campaign', async () => {
    const { client } = await signUp(h.app);
    const c = await newCampaign(client);
    expect(c).toMatchObject({
      name: 'Sales',
      status: 'active',
      routingMode: 'sequential',
      ringTimeoutSec: 20,
      targets: 0,
      numbers: 0,
    });

    const list = data<Array<{ id: string }>>(await client.get('/api/v1/campaigns'));
    expect(list.map((x) => x.id)).toContain(c.id);

    const updated = data<CampaignDto>(
      await client.patch(`/api/v1/campaigns/${c.id}`, {
        name: 'Sales East',
        routingMode: 'simultaneous',
        unavailableMessage: 'We are closed.',
        ivr: { enabled: true, prompt: 'Press {digit} for sales', digit: '4' },
        protection: { attestationPolicy: 'block_failed', perMinute: 3, perHour: null },
      }),
    );
    expect(updated).toMatchObject({
      name: 'Sales East',
      routingMode: 'simultaneous',
      unavailableMessage: 'We are closed.',
      ivr: { enabled: true, prompt: 'Press {digit} for sales', digit: '4', randomDigit: false },
      protection: { attestationPolicy: 'block_failed', perMinute: 3, perHour: null },
    });

    const noDigit = await client.patch(`/api/v1/campaigns/${c.id}`, { ivr: { digit: null } });
    expect(noDigit.statusCode).toBe(422);

    const number = await buyNumber(client);
    await client.post(`/api/v1/campaigns/${c.id}/numbers`, { numberId: number.id });
    const archived = data<CampaignDto>(
      await client.patch(`/api/v1/campaigns/${c.id}`, { status: 'archived' }),
    );
    expect(archived).toMatchObject({ status: 'archived', numbers: 0 });
    expect(
      (
        await client.post(`/api/v1/campaigns/${c.id}/targets`, {
          name: 'x',
          destination: '+14155550101',
        })
      ).statusCode,
    ).toBe(409);
    expect((await client.patch(`/api/v1/campaigns/${c.id}`, { name: 'Nope' })).statusCode).toBe(
      409,
    );
    expect(
      data<CampaignDto>(await client.patch(`/api/v1/campaigns/${c.id}`, { status: 'active' }))
        .status,
    ).toBe('active');

    const inbound = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: number.e164,
    });
    expect(inbound.body).toContain('This number is not configured.'); // archived campaign released its number
  });

  it('validates input', async () => {
    const { client } = await signUp(h.app);
    expect((await client.post('/api/v1/campaigns', { name: '' })).statusCode).toBe(422);
    expect(
      (await client.post('/api/v1/campaigns', { name: 'X', routingMode: 'round_robin' }))
        .statusCode,
    ).toBe(422);
    const c = await newCampaign(client);
    for (const bad of [
      { name: 'A', destination: '415' },
      { name: 'A', destination: '+14155550101', weight: 5000 },
      { name: 'A', destination: '+14155550101', priorityTier: 0 },
      { name: 'A', destination: '+14155550101', ccCap: 0 },
      { name: 'A', destination: '+14155550101', hourlyCap: 0 },
      { name: 'A', destination: '+14155550101', type: 'sip' },
    ]) {
      expect(
        (await client.post(`/api/v1/campaigns/${c.id}/targets`, bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(422);
    }
  });
});

describe('targets and schedules', () => {
  it('adds, edits and archives targets with live usage', async () => {
    const { client } = await signUp(h.app);
    const c = await newCampaign(client);
    let detail = await addTarget(client, c.id, {
      name: 'Primary',
      priorityTier: 1,
      weight: 70,
      ccCap: 2,
      hourlyCap: 10,
    });
    detail = await addTarget(client, c.id, {
      name: 'Backup',
      destination: '+14155550102',
      priorityTier: 2,
    });
    expect(
      detail.targetList.map((t) => [t.name, t.priorityTier, t.weight, t.ccCap, t.hourlyCap]),
    ).toEqual([
      ['Primary', 1, 70, 2, 10],
      ['Backup', 2, 100, 10, null],
    ]);
    expect(detail.targetList[0]?.usage).toEqual({ concurrent: 0, hour: 0, day: 0, total: 0 });
    expect(detail.targetList[0]?.openNow).toBe(true);

    const primary = detail.targetList[0]!;
    const edited = data<CampaignDto>(
      await client.patch(`/api/v1/campaigns/${c.id}/targets/${primary.id}`, {
        enabled: false,
        weight: 0,
      }),
    );
    expect(edited.targetList[0]).toMatchObject({ enabled: false, weight: 0 });
    const removed = data<CampaignDto>(
      await client.del(`/api/v1/campaigns/${c.id}/targets/${primary.id}`),
    );
    expect(removed.targetList.map((t) => t.name)).toEqual(['Backup']);
    expect(
      (await client.patch(`/api/v1/campaigns/${c.id}/targets/${primary.id}`, { enabled: true }))
        .statusCode,
    ).toBe(404);
  });

  it('saves weekly, cross-midnight and dated windows and rejects bad ones', async () => {
    const { client } = await signUp(h.app);
    const c = await newCampaign(client);
    const t = (await addTarget(client, c.id, {})).targetList[0]!;
    const windows = [
      { type: 'weekly', dayOfWeek: 5, open: '22:00', close: '02:00' },
      { type: 'weekly', dayOfWeek: 1, open: '09:00', close: '17:30' },
      { type: 'date', start: '2026-12-25', end: '2026-12-26', kind: 'closed' },
      {
        type: 'date',
        start: '2026-12-31',
        end: '2026-12-31',
        kind: 'open',
        open: '10:00',
        close: '14:00',
      },
    ];
    const saved = data<CampaignDto>(
      await client.request('PUT', `/api/v1/campaigns/${c.id}/targets/${t.id}/schedule`, {
        timezone: 'America/Chicago',
        windows,
      }),
    );
    expect(saved.targetList[0]?.schedule).toEqual({
      timezone: 'America/Chicago',
      windows: [
        { type: 'weekly', dayOfWeek: 1, open: '09:00', close: '17:30' },
        { type: 'weekly', dayOfWeek: 5, open: '22:00', close: '02:00' },
        {
          type: 'date',
          start: '2026-12-25',
          end: '2026-12-26',
          kind: 'closed',
          open: null,
          close: null,
        },
        {
          type: 'date',
          start: '2026-12-31',
          end: '2026-12-31',
          kind: 'open',
          open: '10:00',
          close: '14:00',
        },
      ],
    });
    const put = (body: unknown) =>
      client.request('PUT', `/api/v1/campaigns/${c.id}/targets/${t.id}/schedule`, body);
    expect((await put({ timezone: 'Mars/Base', windows: [] })).statusCode).toBe(422);
    expect(
      (
        await put({
          timezone: 'UTC',
          windows: [{ type: 'weekly', dayOfWeek: 9, open: '09:00', close: '10:00' }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put({
          timezone: 'UTC',
          windows: [{ type: 'weekly', dayOfWeek: 1, open: '9am', close: '10:00' }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put({
          timezone: 'UTC',
          windows: [{ type: 'date', start: '2026-02-02', end: '2026-02-01', kind: 'closed' }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put({
          timezone: 'UTC',
          windows: [
            { type: 'date', start: '2026-02-01', end: '2026-02-01', kind: 'open', open: '10:00' },
          ],
        })
      ).statusCode,
    ).toBe(422);
    const cleared = data<CampaignDto>(
      await client.del(`/api/v1/campaigns/${c.id}/targets/${t.id}/schedule`),
    );
    expect(cleared.targetList[0]?.schedule).toBeNull();
  });
});

describe('numbers on campaigns', () => {
  it('attaches and moves numbers; the next call follows the new routing immediately', async () => {
    const { client } = await signUp(h.app);
    const number = await buyNumber(client, '833');
    await client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550199' });
    const before = parseDial(
      (
        await voice(h.app, '/voice/inbound', {
          CallSid: newCallSid(),
          From: '+13125550100',
          To: number.e164,
        })
      ).body,
    );
    expect(before.numbers[0]?.destination).toBe('+14155550199');

    const c = await newCampaign(client);
    await addTarget(client, c.id, { destination: '+14155550101' });
    const attached = data<CampaignDto>(
      await client.post(`/api/v1/campaigns/${c.id}/numbers`, { numberId: number.id }),
    );
    expect(attached.attachedNumbers.map((n) => n.e164)).toEqual([number.e164]);
    const after = parseDial(
      (
        await voice(h.app, '/voice/inbound', {
          CallSid: newCallSid(),
          From: '+13125550100',
          To: number.e164,
        })
      ).body,
    );
    expect(after.numbers[0]?.destination).toBe('+14155550101');

    const numberDto = data<{ campaign: { id: string; simple: boolean } }>(
      await client.get(`/api/v1/numbers/${number.id}`),
    );
    expect(numberDto.campaign).toMatchObject({ id: c.id, simple: true });
    await addTarget(client, c.id, { name: 'Second', destination: '+14155550102' });
    expect(
      data<{ campaign: { simple: boolean } }>(await client.get(`/api/v1/numbers/${number.id}`))
        .campaign.simple,
    ).toBe(false);
    const quick = await client.patch(`/api/v1/numbers/${number.id}`, { forwardTo: '+14155550111' });
    expect(quick.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(quick).error.code).toBe('campaign_managed');

    const detached = data<CampaignDto>(
      await client.del(`/api/v1/campaigns/${c.id}/numbers/${number.id}`),
    );
    expect(detached.attachedNumbers).toEqual([]);
    const off = await voice(h.app, '/voice/inbound', {
      CallSid: newCallSid(),
      From: '+13125550100',
      To: number.e164,
    });
    expect(off.body).toContain('not configured');
  });
});

describe('routing explanations', () => {
  it('explains a dry run and records why each call was routed the way it was', async () => {
    const { client, orgId } = await signUp(h.app);
    const c = await newCampaign(client);
    await addTarget(client, c.id, { name: 'Primary', ccCap: 1, weight: 75 });
    await addTarget(client, c.id, { name: 'Shared', destination: '+14155550102', weight: 25 });
    const det = await addTarget(client, c.id, {
      name: 'Overflow',
      destination: '+14155550103',
      priorityTier: 2,
    });
    const number = await buyNumber(client, '855');
    await client.post(`/api/v1/campaigns/${c.id}/numbers`, { numberId: number.id });

    const dry = data<ExplainDto>(await client.post(`/api/v1/campaigns/${c.id}/explain`, {}));
    expect(dry.wouldRingTier).toBe(1);
    expect(dry.tiers[0]?.targets.map((t) => [t.name, t.verdict, t.chance])).toEqual([
      ['Primary', 'eligible', 0.75],
      ['Shared', 'eligible', 0.25],
    ]);
    expect(dry.tiers[1]?.targets[0]).toMatchObject({
      name: 'Overflow',
      verdict: 'eligible',
      chance: null,
    });

    // random() = 0.1 → Primary (75%) takes the first call and fills its cap of 1.
    const sid = newCallSid();
    await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: number.e164 });
    const busy = data<ExplainDto>(await client.post(`/api/v1/campaigns/${c.id}/explain`, {}));
    expect(busy.tiers[0]?.targets[0]).toMatchObject({
      name: 'Primary',
      verdict: 'cc_cap',
      usage: { concurrent: 1 },
    });
    expect(busy.tiers[0]?.targets[1]).toMatchObject({ name: 'Shared', chance: 1 });
    const tried = data<ExplainDto>(
      await client.post(`/api/v1/campaigns/${c.id}/explain`, {
        triedTargetIds: det.targetList.slice(0, 2).map((t) => t.id),
      }),
    );
    expect(tried.wouldRingTier).toBe(2);

    const callId = data<Array<{ id: string }>>(await client.get('/api/v1/calls'))[0]!.id;
    const events = data<
      Array<{
        kind: string;
        detail: { tiers?: Array<{ targets: Array<{ name: string; verdict: string }> }> };
      }>
    >(await client.get(`/api/v1/calls/${callId}/routing`));
    expect(events.map((e) => e.kind)).toEqual(['protection', 'attempt']);
    expect(events[1]?.detail.tiers?.[0]?.targets).toEqual([
      expect.objectContaining({ name: 'Primary', verdict: 'picked' }),
      expect.objectContaining({ name: 'Shared', verdict: 'not_picked' }),
    ]);

    const member = await memberOf(orgId);
    expect((await member.get(`/api/v1/calls/${callId}/routing`)).statusCode).toBe(403);
    expect((await member.post(`/api/v1/campaigns/${c.id}/explain`, {})).statusCode).toBe(403);
    expect((await member.get(`/api/v1/campaigns/${c.id}`)).statusCode).toBe(200);
    expect(
      (
        await member.post(`/api/v1/campaigns/${c.id}/targets`, {
          name: 'x',
          destination: '+14155550101',
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('call detail and live calls', () => {
  it('shows attempts and legs, and tracks live state from ringing to connected to gone', async () => {
    const { client } = await signUp(h.app);
    const c = await newCampaign(client);
    await addTarget(client, c.id, { name: 'First', destination: '+14155550101' });
    await addTarget(client, c.id, { name: 'Second', destination: '+14155550102', priorityTier: 2 });
    const number = await buyNumber(client, '866');
    await client.post(`/api/v1/campaigns/${c.id}/numbers`, { numberId: number.id });

    const sid = newCallSid();
    await voice(h.app, '/voice/inbound', { CallSid: sid, From: '+13125550100', To: number.e164 });
    let live = data<LiveCallDto[]>(await client.get('/api/v1/calls/live'));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      state: 'ringing',
      attempt: 1,
      campaign: { name: 'Sales' },
      legs: [{ targetName: 'First', state: 'ringing' }],
    });

    const second = parseDial(
      (await voice(h.app, '/voice/result?attempt=1', { CallSid: sid, DialCallStatus: 'no-answer' }))
        .body,
    );
    const legUrl = second.numbers[0]!.legUrl!.replace(PUBLIC_URL, '');
    await voice(h.app, legUrl, {
      CallSid: 'CAchild2',
      ParentCallSid: sid,
      CallStatus: 'in-progress',
    });
    live = data<LiveCallDto[]>(await client.get('/api/v1/calls/live'));
    expect(live[0]).toMatchObject({
      state: 'connected',
      attempt: 2,
      legs: [{ targetName: 'Second', state: 'connected' }],
    });

    await voice(h.app, '/voice/result?attempt=2', {
      CallSid: sid,
      DialCallStatus: 'completed',
      DialCallDuration: '33',
      DialCallSid: 'CAchild2',
    });
    expect(data<LiveCallDto[]>(await client.get('/api/v1/calls/live'))).toHaveLength(0);

    const callId = data<Array<{ id: string }>>(await client.get('/api/v1/calls'))[0]!.id;
    const detail = data<{
      campaign: { name: string };
      attempts: Array<{ attempt: number; tier: number; dialStatus: string }>;
      legs: Array<{
        attempt: number;
        targetName: string;
        outcome: string;
        talkSeconds: number | null;
      }>;
    }>(await client.get(`/api/v1/calls/${callId}`));
    expect(detail.campaign.name).toBe('Sales');
    expect(detail.attempts.map((a) => [a.attempt, a.tier, a.dialStatus])).toEqual([
      [1, 1, 'no-answer'],
      [2, 2, 'completed'],
    ]);
    expect(detail.legs.map((l) => [l.attempt, l.targetName, l.outcome, l.talkSeconds])).toEqual([
      [1, 'First', 'no_answer', null],
      [2, 'Second', 'completed', 33],
    ]);
  });
});

describe('blocklist', () => {
  it('adds and removes blocked callers, scoped to the organisation', async () => {
    const a = await signUp(h.app);
    const b = await signUp(h.app);
    const added = data<Array<{ id: string; e164: string; reason: string }>>(
      await a.client.post('/api/v1/blocklist', { e164: '+13125550666', reason: 'Robocaller' }),
    );
    expect(added).toEqual([
      expect.objectContaining({ e164: '+13125550666', reason: 'Robocaller' }),
    ]);
    expect((await a.client.post('/api/v1/blocklist', { e164: '+13125550666' })).statusCode).toBe(
      409,
    );
    expect((await a.client.post('/api/v1/blocklist', { e164: '555' })).statusCode).toBe(422);
    expect(data<unknown[]>(await b.client.get('/api/v1/blocklist'))).toEqual([]);
    expect((await b.client.del(`/api/v1/blocklist/${added[0]!.id}`)).statusCode).toBe(404);
    const member = await memberOf(a.orgId);
    expect((await member.get('/api/v1/blocklist')).statusCode).toBe(200);
    expect((await member.post('/api/v1/blocklist', { e164: '+13125550667' })).statusCode).toBe(403);
    expect(data<unknown[]>(await a.client.del(`/api/v1/blocklist/${added[0]!.id}`))).toEqual([]);
  });
});

describe('tenant isolation for routing', () => {
  it('another organisation cannot see or change campaigns, targets, numbers or routing data', async () => {
    const a = await signUp(h.app);
    const b = await signUp(h.app);
    const c = await newCampaign(a.client);
    const t = (await addTarget(a.client, c.id, {})).targetList[0]!;
    const aNumber = await buyNumber(a.client, '877');
    const bCampaign = await newCampaign(b.client, 'B');

    expect(
      data<unknown[]>(await b.client.get('/api/v1/campaigns')).some(
        (x) => (x as { id: string }).id === c.id,
      ),
    ).toBe(false);
    for (const res of [
      await b.client.get(`/api/v1/campaigns/${c.id}`),
      await b.client.patch(`/api/v1/campaigns/${c.id}`, { name: 'Hijack' }),
      await b.client.post(`/api/v1/campaigns/${c.id}/targets`, {
        name: 'x',
        destination: '+14155550101',
      }),
      await b.client.patch(`/api/v1/campaigns/${c.id}/targets/${t.id}`, { weight: 1 }),
      await b.client.del(`/api/v1/campaigns/${c.id}/targets/${t.id}`),
      await b.client.request('PUT', `/api/v1/campaigns/${c.id}/targets/${t.id}/schedule`, {
        timezone: 'UTC',
        windows: [],
      }),
      await b.client.post(`/api/v1/campaigns/${c.id}/explain`, {}),
      await b.client.post(`/api/v1/campaigns/${bCampaign.id}/numbers`, { numberId: aNumber.id }),
      await b.client.patch(`/api/v1/campaigns/${bCampaign.id}/targets/${t.id}`, { weight: 1 }),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    expect(
      data<CampaignDto>(await a.client.get(`/api/v1/campaigns/${c.id}`)).targetList[0]?.weight,
    ).toBe(100);
  });
});
