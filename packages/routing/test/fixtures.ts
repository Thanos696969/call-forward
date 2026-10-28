import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { CompiledTarget } from '@relay/core';

export function target(over: Partial<CompiledTarget> = {}): CompiledTarget {
  return {
    id: randomUUID(),
    name: 'Target',
    type: 'phone',
    destination: '+14155550123',
    priorityTier: 1,
    weight: 100,
    enabled: true,
    ccCap: 10,
    hourlyCap: null,
    dailyCap: null,
    totalCap: null,
    schedule: null,
    capTimezone: 'UTC',
    ...over,
  };
}

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An organisation, campaign and the given targets persisted in Postgres. */
export async function seedCampaign(sql: Sql, targets: CompiledTarget[]) {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Routing Test', ${`rt-${randomUUID()}`}) returning id`;
  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (org_id, name) values (${org!.id}, 'Test') returning id`;
  for (const t of targets) {
    await sql`
      insert into targets (id, org_id, campaign_id, name, destination, weight, priority_tier, cc_cap,
                           hourly_cap, daily_cap, total_cap, enabled)
      values (${t.id}, ${org!.id}, ${campaign!.id}, ${t.name}, ${t.destination}, ${t.weight}, ${t.priorityTier},
              ${t.ccCap}, ${t.hourlyCap}, ${t.dailyCap}, ${t.totalCap}, ${t.enabled})`;
  }
  return { orgId: org!.id, campaignId: campaign!.id };
}

/** A call with one attempt, as the voice path would record it. */
export async function seedCall(
  sql: Sql,
  orgId: string,
  campaignId: string,
  callSid = `CA${randomUUID().replace(/-/g, '')}`,
) {
  const [call] = await sql<{ id: string }[]>`
    insert into calls (org_id, campaign_id, provider, provider_call_id, from_e164, to_e164)
    values (${orgId}, ${campaignId}, 'mock', ${callSid}, '+13125550100', '+18005550100') returning id`;
  await sql`
    insert into call_attempts (call_id, org_id, attempt, mode, tier, ring_timeout_sec)
    values (${call!.id}, ${orgId}, 1, 'sequential', 1, 25)`;
  return { callId: call!.id, callSid };
}
