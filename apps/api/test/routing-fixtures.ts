import type { Harness } from './harness';

export interface TargetSpec {
  name: string;
  destination: string;
  tier?: number;
  weight?: number;
  ccCap?: number;
  hourlyCap?: number | null;
  dailyCap?: number | null;
  totalCap?: number | null;
  enabled?: boolean;
  schedule?: {
    timezone: string;
    windows: Array<{
      dayOfWeek?: number;
      open?: string;
      close?: string;
      dateStart?: string;
      dateEnd?: string;
      kind?: 'open' | 'closed';
    }>;
  };
}

export interface CampaignSpec {
  mode?: 'sequential' | 'simultaneous';
  ringTimeoutSec?: number;
  ivr?: { prompt?: string; digit?: string; random?: boolean };
  attestation?: 'allow_all' | 'block_failed' | 'require_a_or_b' | 'require_a';
  perMinute?: number | null;
  perHour?: number | null;
  unavailableMessage?: string;
}

/**
 * Point a number at a fresh campaign with the given targets (direct SQL: the
 * control-plane API has its own tests) and drop the cached route.
 */
export async function routeNumber(
  h: Harness,
  orgId: string,
  numberId: string,
  campaign: CampaignSpec,
  targets: TargetSpec[],
) {
  const sql = h.deps.sql;
  const [c] = await sql<{ id: string }[]>`
    insert into campaigns (org_id, name, routing_mode, ring_timeout_sec, ivr_enabled, ivr_prompt, ivr_digit,
                           ivr_random_digit, attestation_policy, caller_limit_per_minute, caller_limit_per_hour, unavailable_message)
    values (${orgId}, 'Routing test', ${campaign.mode ?? 'sequential'}, ${campaign.ringTimeoutSec ?? 20},
            ${Boolean(campaign.ivr)}, ${campaign.ivr?.prompt ?? null}, ${campaign.ivr?.digit ?? null}, ${campaign.ivr?.random ?? false},
            ${campaign.attestation ?? 'allow_all'}, ${campaign.perMinute ?? null}, ${campaign.perHour ?? null},
            ${campaign.unavailableMessage ?? null})
    returning id`;
  const ids: Record<string, string> = {};
  let order = 0;
  for (const t of targets) {
    const [row] = await sql<{ id: string }[]>`
      insert into targets (org_id, campaign_id, name, destination, priority_tier, weight, cc_cap, hourly_cap, daily_cap, total_cap, enabled, created_at)
      values (${orgId}, ${c!.id}, ${t.name}, ${t.destination}, ${t.tier ?? 1}, ${t.weight ?? 100}, ${t.ccCap ?? 10},
              ${t.hourlyCap ?? null}, ${t.dailyCap ?? null}, ${t.totalCap ?? null}, ${t.enabled ?? true},
              now() + make_interval(secs => ${order++}))
      returning id`;
    ids[t.name] = row!.id;
    if (t.schedule) {
      const [s] = await sql<
        { id: string }[]
      >`insert into schedules (target_id, timezone) values (${row!.id}, ${t.schedule.timezone}) returning id`;
      for (const w of t.schedule.windows) {
        await sql`insert into schedule_windows (schedule_id, day_of_week, open_time, close_time, date_start, date_end, kind)
                  values (${s!.id}, ${w.dayOfWeek ?? null}, ${w.open ?? null}, ${w.close ?? null}, ${w.dateStart ?? null}, ${w.dateEnd ?? null}, ${w.kind ?? 'open'})`;
      }
    }
  }
  const [n] = await sql<
    { e164: string }[]
  >`update phone_numbers set campaign_id = ${c!.id} where id = ${numberId} returning e164`;
  await h.app.routeCache.invalidate(n!.e164);
  return { campaignId: c!.id, targetIds: ids };
}

/** Pull the destinations and URLs out of a <Dial> response. */
export function parseDial(twiml: string) {
  const action = /<Dial[^>]*action="([^"]+)"/.exec(twiml)?.[1]?.replace(/&amp;/g, '&') ?? null;
  const numbers = [
    ...twiml.matchAll(/<Number(?: [^>]*statusCallback="([^"]+)")?[^>]*>([^<]+)<\/Number>/g),
  ].map((m) => ({
    destination: m[2]!,
    legUrl: m[1]?.replace(/&amp;/g, '&') ?? null,
  }));
  return {
    action,
    numbers,
    attempt: action ? Number(new URL(action).searchParams.get('attempt')) : null,
  };
}
