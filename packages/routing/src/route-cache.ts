import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import type { CompiledCampaign, CompiledRoute, CompiledTarget, ScheduleWindow } from '@relay/core';
import { keys } from './keys';

export const ROUTE_CACHE_TTL_SEC = 60;

interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface RouteRow {
  number_id: string;
  org_id: string;
  org_timezone: string;
  e164: string;
  org_status: CompiledRoute['orgStatus'];
  campaign: {
    id: string;
    name: string;
    status: CompiledCampaign['status'];
    routing_mode: CompiledCampaign['routingMode'];
    ring_timeout_sec: number;
    ivr_enabled: boolean;
    ivr_prompt: string | null;
    ivr_digit: string | null;
    ivr_random_digit: boolean;
    ivr_timeout_sec: number;
    attestation_policy: CompiledCampaign['protection']['attestationPolicy'];
    caller_limit_per_minute: number | null;
    caller_limit_per_hour: number | null;
    unavailable_message: string | null;
  } | null;
  targets: Array<{
    id: string;
    name: string;
    type: CompiledTarget['type'];
    destination: string;
    priority_tier: number;
    weight: number;
    enabled: boolean;
    cc_cap: number;
    hourly_cap: number | null;
    daily_cap: number | null;
    total_cap: number | null;
    schedule_tz: string | null;
    windows: Array<{
      day_of_week: number | null;
      open_time: string | null;
      close_time: string | null;
      date_start: string | null;
      date_end: string | null;
      kind: 'open' | 'closed';
    }> | null;
  }>;
}

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/** Load everything the voice path needs for a number in one query. */
export async function compileRoute(sql: Sql, e164: string): Promise<CompiledRoute | null> {
  const rows = await sql<RouteRow[]>`
    select pn.id as number_id, pn.org_id, pn.e164, o.status as org_status, o.timezone as org_timezone,
      (select to_json(c) from (
         select id, name, status, routing_mode, ring_timeout_sec, ivr_enabled, ivr_prompt, ivr_digit,
                ivr_random_digit, ivr_timeout_sec, attestation_policy, caller_limit_per_minute,
                caller_limit_per_hour, unavailable_message
         from campaigns where id = pn.campaign_id and org_id = pn.org_id) c) as campaign,
      (select coalesce(json_agg(t order by t.priority_tier, t.created_at, t.id), '[]'::json) from (
         select tg.id, tg.name, tg.target_type as type, tg.destination, tg.priority_tier, tg.weight,
                tg.enabled, tg.cc_cap, tg.hourly_cap, tg.daily_cap, tg.total_cap, tg.created_at,
                s.timezone as schedule_tz,
                (select json_agg(json_build_object(
                   'day_of_week', w.day_of_week, 'open_time', w.open_time, 'close_time', w.close_time,
                   'date_start', w.date_start, 'date_end', w.date_end, 'kind', w.kind)
                   order by (w.date_start is not null), w.day_of_week, w.date_start, w.open_time)
                 from schedule_windows w where w.schedule_id = s.id) as windows
         from targets tg
         left join schedules s on s.target_id = tg.id
         where tg.campaign_id = pn.campaign_id and tg.org_id = pn.org_id and tg.archived_at is null) t
      ) as targets
    from phone_numbers pn
    join organizations o on o.id = pn.org_id
    where pn.e164 = ${e164} and pn.status = 'active'
    limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    version: 2,
    numberId: row.number_id,
    orgId: row.org_id,
    orgTimezone: row.org_timezone,
    e164: row.e164,
    orgStatus: row.org_status,
    campaign: row.campaign ? mapCampaign(row.campaign) : null,
    targets: mapTargets(row.targets, row.org_timezone),
  };
}

type CampaignRow = NonNullable<RouteRow['campaign']>;
type TargetRow = RouteRow['targets'][number];

function mapCampaign(c: CampaignRow): CompiledCampaign {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    routingMode: c.routing_mode,
    ringTimeoutSec: c.ring_timeout_sec,
    ivr: {
      enabled: c.ivr_enabled,
      prompt: c.ivr_prompt,
      digit: c.ivr_digit,
      randomDigit: c.ivr_random_digit,
      timeoutSec: c.ivr_timeout_sec,
    },
    protection: {
      attestationPolicy: c.attestation_policy,
      perMinute: c.caller_limit_per_minute,
      perHour: c.caller_limit_per_hour,
    },
    unavailableMessage: c.unavailable_message,
  };
}

function mapTargets(rows: TargetRow[], orgTimezone: string): CompiledTarget[] {
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    destination: t.destination,
    priorityTier: t.priority_tier,
    weight: t.weight,
    enabled: t.enabled,
    ccCap: t.cc_cap,
    hourlyCap: t.hourly_cap,
    dailyCap: t.daily_cap,
    totalCap: t.total_cap,
    capTimezone: t.schedule_tz ?? orgTimezone,
    schedule: t.schedule_tz
      ? { timezone: t.schedule_tz, windows: (t.windows ?? []).map(toWindow) }
      : null,
  }));
}

/** Compile a campaign on its own (no number): used by the routing dry-run. Org-scoped. */
export async function compileCampaign(
  sql: Sql,
  orgId: string,
  campaignId: string,
): Promise<{
  campaign: CompiledCampaign;
  targets: CompiledTarget[];
  orgTimezone: string;
  orgStatus: CompiledRoute['orgStatus'];
} | null> {
  const rows = await sql<
    Array<{
      org_timezone: string;
      org_status: CompiledRoute['orgStatus'];
      campaign: CampaignRow;
      targets: TargetRow[];
    }>
  >`
    select o.timezone as org_timezone, o.status as org_status,
      (select to_json(c) from (
         select id, name, status, routing_mode, ring_timeout_sec, ivr_enabled, ivr_prompt, ivr_digit,
                ivr_random_digit, ivr_timeout_sec, attestation_policy, caller_limit_per_minute,
                caller_limit_per_hour, unavailable_message
         from campaigns where id = ${campaignId} and org_id = ${orgId}) c) as campaign,
      (select coalesce(json_agg(t order by t.priority_tier, t.created_at, t.id), '[]'::json) from (
         select tg.id, tg.name, tg.target_type as type, tg.destination, tg.priority_tier, tg.weight,
                tg.enabled, tg.cc_cap, tg.hourly_cap, tg.daily_cap, tg.total_cap, tg.created_at,
                s.timezone as schedule_tz,
                (select json_agg(json_build_object(
                   'day_of_week', w.day_of_week, 'open_time', w.open_time, 'close_time', w.close_time,
                   'date_start', w.date_start, 'date_end', w.date_end, 'kind', w.kind)
                   order by (w.date_start is not null), w.day_of_week, w.date_start, w.open_time)
                 from schedule_windows w where w.schedule_id = s.id) as windows
         from targets tg
         left join schedules s on s.target_id = tg.id
         where tg.campaign_id = ${campaignId} and tg.org_id = ${orgId} and tg.archived_at is null) t
      ) as targets
    from organizations o where o.id = ${orgId}`;
  const row = rows[0];
  if (!row?.campaign) return null;
  return {
    campaign: mapCampaign(row.campaign),
    targets: mapTargets(row.targets, row.org_timezone),
    orgTimezone: row.org_timezone,
    orgStatus: row.org_status,
  };
}

function toWindow(w: NonNullable<TargetRow['windows']>[number]): ScheduleWindow {
  if (w.day_of_week !== null && w.date_start === null) {
    return {
      type: 'weekly',
      dayOfWeek: w.day_of_week,
      open: hhmm(w.open_time) ?? '00:00',
      close: hhmm(w.close_time) ?? '00:00',
    };
  }
  return {
    type: 'date',
    start: w.date_start ?? '',
    end: w.date_end ?? '',
    kind: w.kind,
    open: hhmm(w.open_time),
    close: hhmm(w.close_time),
  };
}

/**
 * Hot-path projection of routing config. Postgres is the source of truth; Redis
 * holds a 60 s copy, invalidated on every change. If Redis is unavailable the
 * router reads Postgres directly rather than failing the call.
 */
export class RouteCache {
  constructor(
    private readonly redis: Redis,
    private readonly sql: Sql,
    private readonly log: Logger,
  ) {}

  async get(e164: string): Promise<CompiledRoute | null> {
    try {
      const cached = await this.redis.get(keys.route(e164));
      if (cached) {
        const parsed = JSON.parse(cached) as { version?: number };
        if (parsed.version === 2) return parsed as CompiledRoute;
      }
    } catch (err) {
      this.log.warn({ err }, 'route cache read failed; falling back to database');
    }
    const route = await compileRoute(this.sql, e164);
    if (route) {
      try {
        await this.redis.set(keys.route(e164), JSON.stringify(route), 'EX', ROUTE_CACHE_TTL_SEC);
      } catch (err) {
        this.log.warn({ err }, 'route cache write failed');
      }
    }
    return route;
  }

  async invalidate(...e164s: string[]): Promise<void> {
    if (e164s.length === 0) return;
    try {
      await this.redis.del(...e164s.map(keys.route));
    } catch (err) {
      // A stale entry expires within the TTL; log loudly so it is visible.
      this.log.error({ err }, 'route cache invalidation failed');
    }
  }

  /** Invalidate every number attached to a campaign. */
  async invalidateCampaign(campaignId: string): Promise<void> {
    const rows = await this.sql<{ e164: string }[]>`
      select e164 from phone_numbers where campaign_id = ${campaignId} and status <> 'released'`;
    await this.invalidate(...rows.map((r) => r.e164));
  }
}
