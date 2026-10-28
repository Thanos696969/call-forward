import type { Sql } from 'postgres';
import {
  capWindowKeys,
  effectiveWeight,
  isOpenAt,
  staticIneligibility,
  type CampaignDto,
  type CampaignSummaryDto,
  type CompiledTarget,
  type ExplainDto,
  type ExplainTargetDto,
  type ScheduleWindow,
  type TargetDto,
  type TargetUsageDto,
} from '@relay/core';
import { compileCampaign, type RedisReserver } from '@relay/routing';
import { notFound } from '../lib/errors';

interface SummaryRow {
  id: string;
  name: string;
  status: CampaignSummaryDto['status'];
  routing_mode: CampaignSummaryDto['routingMode'];
  ring_timeout_sec: number;
  ivr_enabled: boolean;
  created_at: Date;
  numbers: number;
  targets: number;
  enabled_targets: number;
}

function toSummary(r: SummaryRow): CampaignSummaryDto {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    routingMode: r.routing_mode,
    ringTimeoutSec: r.ring_timeout_sec,
    ivrEnabled: r.ivr_enabled,
    numbers: r.numbers,
    targets: r.targets,
    enabledTargets: r.enabled_targets,
    createdAt: r.created_at.toISOString(),
  };
}

export async function listCampaigns(
  sql: Sql,
  orgId: string,
  opts: { id?: string } = {},
): Promise<CampaignSummaryDto[]> {
  const rows = await sql<SummaryRow[]>`
    select c.id, c.name, c.status, c.routing_mode, c.ring_timeout_sec, c.ivr_enabled, c.created_at,
      (select count(*)::int from phone_numbers p where p.campaign_id = c.id and p.org_id = c.org_id and p.status <> 'released') as numbers,
      (select count(*)::int from targets t where t.campaign_id = c.id and t.org_id = c.org_id and t.archived_at is null) as targets,
      (select count(*)::int from targets t where t.campaign_id = c.id and t.org_id = c.org_id and t.archived_at is null and t.enabled) as enabled_targets
    from campaigns c
    where c.org_id = ${orgId} ${opts.id ? sql`and c.id = ${opts.id}` : sql``}
    order by (c.status = 'archived'), c.created_at desc`;
  return rows.map(toSummary);
}

interface DetailRow extends SummaryRow {
  ivr_prompt: string | null;
  ivr_digit: string | null;
  ivr_random_digit: boolean;
  ivr_timeout_sec: number;
  attestation_policy: CampaignDto['protection']['attestationPolicy'];
  caller_limit_per_minute: number | null;
  caller_limit_per_hour: number | null;
  unavailable_message: string | null;
}

/** Full campaign with numbers and targets (incl. live usage). Org-scoped; 404 when not found. */
export async function getCampaign(
  sql: Sql,
  reserver: RedisReserver,
  orgId: string,
  id: string,
  now = new Date(),
): Promise<CampaignDto> {
  const [row] = await sql<DetailRow[]>`
    select c.*,
      (select count(*)::int from phone_numbers p where p.campaign_id = c.id and p.org_id = c.org_id and p.status <> 'released') as numbers,
      (select count(*)::int from targets t where t.campaign_id = c.id and t.org_id = c.org_id and t.archived_at is null) as targets,
      (select count(*)::int from targets t where t.campaign_id = c.id and t.org_id = c.org_id and t.archived_at is null and t.enabled) as enabled_targets
    from campaigns c where c.id = ${id} and c.org_id = ${orgId}`;
  if (!row) throw notFound('Campaign');
  const numbers = await sql<
    { id: string; e164: string; status: CampaignDto['attachedNumbers'][number]['status'] }[]
  >`
    select id, e164, status from phone_numbers
    where campaign_id = ${id} and org_id = ${orgId} and status <> 'released' order by created_at`;
  const compiled = await compileCampaign(sql, orgId, id);
  const createdAt = await sql<{ id: string; created_at: Date }[]>`
    select id, created_at from targets where campaign_id = ${id} and org_id = ${orgId} and archived_at is null`;
  const created = new Map(createdAt.map((r) => [r.id, r.created_at]));
  const usage = await usageFor(reserver, compiled?.targets ?? [], now);
  return {
    ...toSummary(row),
    ivr: {
      enabled: row.ivr_enabled,
      prompt: row.ivr_prompt,
      digit: row.ivr_digit,
      randomDigit: row.ivr_random_digit,
      timeoutSec: row.ivr_timeout_sec,
    },
    protection: {
      attestationPolicy: row.attestation_policy,
      perMinute: row.caller_limit_per_minute,
      perHour: row.caller_limit_per_hour,
    },
    unavailableMessage: row.unavailable_message,
    attachedNumbers: numbers,
    targetList: (compiled?.targets ?? []).map((t) =>
      toTargetDto(t, usage[t.id] ?? null, created.get(t.id), now),
    ),
  };
}

export function toTargetDto(
  t: CompiledTarget,
  usage: TargetUsageDto | null,
  createdAt: Date | undefined,
  now: Date,
): TargetDto {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    destination: t.destination,
    priorityTier: t.priorityTier,
    weight: t.weight,
    ccCap: t.ccCap,
    hourlyCap: t.hourlyCap,
    dailyCap: t.dailyCap,
    totalCap: t.totalCap,
    enabled: t.enabled,
    schedule: t.schedule
      ? { timezone: t.schedule.timezone, windows: t.schedule.windows as ScheduleWindow[] }
      : null,
    usage,
    openNow: isOpenAt(t.schedule, now),
    createdAt: (createdAt ?? now).toISOString(),
  };
}

/** Live counters for targets; null per target if Redis is unavailable. */
export async function usageFor(
  reserver: RedisReserver,
  targets: CompiledTarget[],
  now: Date,
): Promise<Record<string, TargetUsageDto | null>> {
  if (targets.length === 0) return {};
  try {
    return await reserver.usage(
      targets.map((t) => {
        const k = capWindowKeys(t.capTimezone, now);
        return { target: t, hourKey: k.hour, dayKey: k.day };
      }),
      now,
    );
  } catch {
    return Object.fromEntries(targets.map((t) => [t.id, null]));
  }
}

/**
 * Dry-run of the router for a call arriving at `at`: every target's verdict,
 * the tier that would ring, and each eligible target's chance of being picked.
 * Read-only: nothing is reserved.
 */
export async function explainCampaign(
  sql: Sql,
  reserver: RedisReserver,
  orgId: string,
  campaignId: string,
  at: Date,
  tried: ReadonlySet<string>,
): Promise<ExplainDto> {
  const compiled = await compileCampaign(sql, orgId, campaignId);
  if (!compiled) throw notFound('Campaign');
  const usage = await usageFor(reserver, compiled.targets, at);
  const tiers = new Map<number, ExplainTargetDto[]>();
  const effective = new Map<string, number>();
  for (const t of compiled.targets) {
    const u = usage[t.id] ?? null;
    let verdict: ExplainTargetDto['verdict'] = staticIneligibility(t, tried, at) ?? 'eligible';
    if (verdict === 'eligible' && u) {
      if (u.concurrent >= t.ccCap) verdict = 'cc_cap';
      else if (t.hourlyCap !== null && u.hour >= t.hourlyCap) verdict = 'hourly_cap';
      else if (t.dailyCap !== null && u.day >= t.dailyCap) verdict = 'daily_cap';
      else if (t.totalCap !== null && u.total >= t.totalCap) verdict = 'total_cap';
    }
    if (verdict === 'eligible')
      effective.set(t.id, effectiveWeight(t.weight, u?.concurrent ?? 0, t.ccCap));
    const list = tiers.get(t.priorityTier) ?? [];
    list.push({
      targetId: t.id,
      name: t.name,
      destination: t.destination,
      verdict,
      usage: u,
      chance: null,
    });
    tiers.set(t.priorityTier, list);
  }
  const ordered = [...tiers.entries()].sort(([a], [b]) => a - b);
  const ringing = ordered.find(([, ts]) => ts.some((t) => t.verdict === 'eligible'));
  const campaignActive = compiled.campaign.status === 'active' && compiled.orgStatus === 'active';
  if (ringing && campaignActive) {
    const eligible = ringing[1].filter((t) => t.verdict === 'eligible');
    const total = eligible.reduce((a, t) => a + (effective.get(t.targetId) ?? 0), 0);
    for (const t of eligible) {
      t.chance =
        compiled.campaign.routingMode === 'simultaneous'
          ? 1
          : total > 0
            ? (effective.get(t.targetId) ?? 0) / total
            : 0;
    }
  }
  return {
    at: at.toISOString(),
    mode: compiled.campaign.routingMode,
    campaignStatus: compiled.campaign.status,
    wouldRingTier: campaignActive && ringing ? ringing[0] : null,
    tiers: ordered.map(([tier, targets]) => ({ tier, targets })),
  };
}
