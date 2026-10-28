import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  FAILED_OUTCOMES,
  MISSED_OUTCOMES,
  dashboardQuerySchema,
  listCallsQuerySchema,
  type CallAttemptDto,
  type CallDetailDto,
  type LiveCallDto,
  type RoutingEventDto,
  type CallDto,
  type DashboardSummaryDto,
} from '@relay/core';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { badRequest, notFound } from '../lib/errors';
import { iso, isoReq, ok } from '../lib/http';
import { READ_ROLES, WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { getOrg } from '../services/org';
import { assertId, idParams } from './numbers';

interface CallRow {
  id: string;
  number_id: string | null;
  to_e164: string;
  from_e164: string;
  destination: string | null;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  ring_seconds: number | null;
  talk_seconds: number | null;
  billed_seconds: number | null;
  outcome: CallDto['outcome'];
  provider: string;
}

function toCallDto(r: CallRow): CallDto {
  return {
    id: r.id,
    numberId: r.number_id,
    numberE164: r.to_e164,
    from: r.from_e164,
    destination: r.destination,
    startedAt: isoReq(r.started_at),
    answeredAt: iso(r.answered_at),
    endedAt: iso(r.ended_at),
    ringSeconds: r.ring_seconds,
    talkSeconds: r.talk_seconds,
    billedSeconds: r.billed_seconds,
    outcome: r.outcome,
    provider: r.provider,
  };
}

const summaryQuerySchema = dashboardQuerySchema.extend({
  /** Convenience: last N days ending now, starting at local midnight in the org timezone. */
  days: z.coerce.number().int().min(1).max(366).optional(),
});

export const callRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const { sql } = deps;

  app.get(
    '/calls',
    {
      schema: { tags: ['calls'], querystring: listCallsQuerySchema },
      preHandler: requireRole(deps, ...READ_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const q = req.query;
      let cursor: { sortKey: string; id: string } | null = null;
      if (q.cursor) {
        cursor = decodeCursor(q.cursor);
        if (Number.isNaN(Date.parse(cursor.sortKey)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) {
          throw badRequest('invalid_cursor', 'The pagination cursor is invalid');
        }
      }
      const rows = await sql<CallRow[]>`
        select c.id, c.number_id, c.to_e164, c.from_e164,
               coalesce(t.destination, c.metadata->>'destination') as destination,
               c.started_at, c.answered_at, c.ended_at, c.ring_seconds, c.talk_seconds,
               c.billed_seconds, c.outcome, c.provider
        from calls c
        left join targets t on t.id = c.target_id and t.org_id = c.org_id
        where c.org_id = ${auth.orgId}
          ${q.from ? sql`and c.started_at >= ${new Date(q.from)}` : sql``}
          ${q.to ? sql`and c.started_at < ${new Date(q.to)}` : sql``}
          ${q.outcome ? sql`and c.outcome = ${q.outcome}` : sql``}
          ${q.numberId ? sql`and c.number_id = ${q.numberId}` : sql``}
          ${cursor ? sql`and (c.started_at, c.id) < (${new Date(cursor.sortKey)}::timestamptz, ${cursor.id}::uuid)` : sql``}
        order by c.started_at desc, c.id desc
        limit ${q.limit + 1}`;
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return ok(page.map(toCallDto), {
        nextCursor:
          rows.length > q.limit && last ? encodeCursor(isoReq(last.started_at), last.id) : null,
      });
    },
  );

  app.get(
    '/calls/live',
    { schema: { tags: ['calls'] }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => {
      const auth = authOf(req);
      const rows = await sql<
        {
          id: string;
          from_e164: string;
          to_e164: string;
          started_at: Date;
          campaign_id: string | null;
          campaign_name: string | null;
          metadata: { lastResponse?: { kind?: string }; ivrResult?: string };
          attempt: number | null;
          legs: Array<{
            target_id: string | null;
            target_name: string | null;
            destination: string | null;
            attempt: number;
            started_at: string;
            answered_at: string | null;
          }> | null;
        }[]
      >`
        select c.id, c.from_e164, c.to_e164, c.started_at, c.campaign_id, cp.name as campaign_name, c.metadata,
          (select max(a.attempt) from call_attempts a where a.call_id = c.id) as attempt,
          (select json_agg(json_build_object('target_id', l.target_id, 'target_name', t.name, 'destination', l.destination,
                   'attempt', l.attempt, 'started_at', l.started_at, 'answered_at', l.answered_at) order by l.started_at)
           from call_legs l left join targets t on t.id = l.target_id and t.org_id = c.org_id
           where l.call_id = c.id and l.ended_at is null) as legs
        from calls c
        left join campaigns cp on cp.id = c.campaign_id and cp.org_id = c.org_id
        where c.org_id = ${auth.orgId} and c.outcome = 'in_progress' and c.started_at > now() - interval '4 hours'
        order by c.started_at desc
        limit 200`;
      const data: LiveCallDto[] = rows.map((r) => {
        const legs = (r.legs ?? []).map((l) => ({
          targetId: l.target_id,
          targetName: l.target_name,
          destination: l.destination,
          attempt: l.attempt,
          state: (l.answered_at ? 'connected' : 'ringing') as 'connected' | 'ringing',
          startedAt: new Date(l.started_at).toISOString(),
          answeredAt: l.answered_at ? new Date(l.answered_at).toISOString() : null,
        }));
        const state: LiveCallDto['state'] =
          r.metadata.lastResponse?.kind === 'gather' && !r.metadata.ivrResult
            ? 'ivr'
            : legs.some((l) => l.state === 'connected')
              ? 'connected'
              : legs.length > 0
                ? 'ringing'
                : 'routing';
        return {
          id: r.id,
          from: r.from_e164,
          numberE164: r.to_e164,
          campaign:
            r.campaign_id && r.campaign_name ? { id: r.campaign_id, name: r.campaign_name } : null,
          startedAt: isoReq(r.started_at),
          state,
          attempt: r.attempt ?? 0,
          legs,
        };
      });
      return ok(data, { serverTime: new Date().toISOString() });
    },
  );

  app.get(
    '/calls/:id',
    { schema: { tags: ['calls'], params: idParams }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => {
      const auth = authOf(req);
      const id = assertId(req.params.id, 'Call');
      const [row] = await sql<
        (CallRow & {
          provider_call_id: string;
          hangup_cause: string | null;
          metadata: Record<string, unknown>;
          campaign_id: string | null;
          campaign_name: string | null;
        })[]
      >`
        select c.id, c.number_id, c.to_e164, c.from_e164,
               coalesce(t.destination, c.metadata->>'destination') as destination,
               c.started_at, c.answered_at, c.ended_at, c.ring_seconds, c.talk_seconds,
               c.billed_seconds, c.outcome, c.provider, c.provider_call_id, c.hangup_cause, c.metadata,
               c.campaign_id, cp.name as campaign_name
        from calls c
        left join targets t on t.id = c.target_id and t.org_id = c.org_id
        left join campaigns cp on cp.id = c.campaign_id and cp.org_id = c.org_id
        where c.org_id = ${auth.orgId} and c.id = ${id}`;
      if (!row) throw notFound('Call');
      const legs = await sql<
        {
          id: string;
          attempt: number;
          tier: number | null;
          target_id: string | null;
          target_name: string | null;
          destination: string | null;
          talk_seconds: number | null;
          started_at: Date;
          answered_at: Date | null;
          ended_at: Date | null;
          outcome: string | null;
          sip_code: number | null;
        }[]
      >`
        select l.id, l.attempt, l.tier, l.target_id, t.name as target_name,
               coalesce(l.destination, t.destination) as destination, l.talk_seconds,
               l.started_at, l.answered_at, l.ended_at, l.outcome, l.sip_code
        from call_legs l
        join calls c on c.id = l.call_id and c.org_id = ${auth.orgId}
        left join targets t on t.id = l.target_id and t.org_id = c.org_id
        where l.call_id = ${id}
        order by l.attempt, l.started_at, l.id`;
      const attempts = await sql<
        {
          attempt: number;
          mode: CallAttemptDto['mode'];
          tier: number;
          ring_timeout_sec: number;
          dial_status: string | null;
          created_at: Date;
          completed_at: Date | null;
        }[]
      >`
        select attempt, mode, tier, ring_timeout_sec, dial_status, created_at, completed_at
        from call_attempts where call_id = ${id} and org_id = ${auth.orgId} order by attempt`;
      const dto: CallDetailDto = {
        ...toCallDto(row),
        providerCallId: row.provider_call_id,
        hangupCause: row.hangup_cause,
        metadata: row.metadata,
        campaign:
          row.campaign_id && row.campaign_name
            ? { id: row.campaign_id, name: row.campaign_name }
            : null,
        attempts: attempts.map((a) => ({
          attempt: a.attempt,
          mode: a.mode,
          tier: a.tier,
          ringTimeoutSec: a.ring_timeout_sec,
          dialStatus: a.dial_status,
          createdAt: isoReq(a.created_at),
          completedAt: iso(a.completed_at),
        })),
        legs: legs.map((l) => ({
          id: l.id,
          attempt: l.attempt,
          tier: l.tier,
          targetId: l.target_id,
          targetName: l.target_name,
          talkSeconds: l.talk_seconds,
          destination: l.destination ?? row.destination,
          startedAt: isoReq(l.started_at),
          answeredAt: iso(l.answered_at),
          endedAt: iso(l.ended_at),
          outcome: l.outcome,
          sipCode: l.sip_code,
        })),
      };
      return ok(dto);
    },
  );

  /** Admin-only: why the router did what it did on this call, attempt by attempt. */
  app.get(
    '/calls/:id/routing',
    {
      schema: { tags: ['routing'], params: idParams },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const id = assertId(req.params.id, 'Call');
      const [exists] = await sql<
        { id: string }[]
      >`select id from calls where id = ${id} and org_id = ${auth.orgId}`;
      if (!exists) throw notFound('Call');
      const events = await sql<
        {
          id: bigint;
          kind: RoutingEventDto['kind'];
          attempt: number | null;
          detail: Record<string, unknown>;
          created_at: Date;
        }[]
      >`
        select id, kind, attempt, detail, created_at from call_routing_events
        where call_id = ${id} and org_id = ${auth.orgId} order by id`;
      return ok<RoutingEventDto[]>(
        events.map((e) => ({
          id: e.id.toString(),
          kind: e.kind,
          attempt: e.attempt,
          detail: e.detail,
          createdAt: isoReq(e.created_at),
        })),
      );
    },
  );

  app.get(
    '/dashboard/summary',
    {
      schema: { tags: ['calls'], querystring: summaryQuerySchema },
      preHandler: requireRole(deps, ...READ_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const org = await getOrg(deps, auth.orgId);
      const tz = org.timezone;
      const now = new Date();
      let from: Date;
      let to: Date = req.query.to ? new Date(req.query.to) : now;
      if (req.query.from) {
        from = new Date(req.query.from);
      } else {
        const days = req.query.days ?? 7;
        const [r] = await sql<{ start: Date }[]>`
          select ((date_trunc('day', ${now}::timestamptz at time zone ${tz}) - make_interval(days => ${days - 1}))
                  at time zone ${tz}) as start`;
        from = r?.start ?? new Date(now.getTime() - days * 86_400_000);
      }
      if (to <= from) to = new Date(from.getTime() + 1);
      if (to.getTime() - from.getTime() > 400 * 86_400_000) {
        throw badRequest('range_too_large', 'Choose a range of 400 days or less');
      }

      const daily = await sql<
        {
          day: string;
          calls: number;
          answered: number;
          talk: number;
          missed: number;
          failed: number;
        }[]
      >`
        select to_char((started_at at time zone ${tz})::date, 'YYYY-MM-DD') as day,
               count(*)::int as calls,
               count(*) filter (where outcome = 'completed')::int as answered,
               coalesce(sum(talk_seconds), 0)::int as talk,
               count(*) filter (where outcome in ${sql(MISSED_OUTCOMES as string[])})::int as missed,
               count(*) filter (where outcome in ${sql(FAILED_OUTCOMES as string[])})::int as failed
        from calls
        where org_id = ${auth.orgId} and started_at >= ${from} and started_at < ${to}
        group by 1 order by 1`;

      const byDay = new Map(daily.map((d) => [d.day, d]));
      const series: DashboardSummaryDto['daily'] = [];
      for (const day of localDays(from, to, tz)) {
        const d = byDay.get(day);
        series.push({
          date: day,
          calls: d?.calls ?? 0,
          answered: d?.answered ?? 0,
          minutes: Math.ceil((d?.talk ?? 0) / 60),
        });
      }
      const totals = daily.reduce(
        (acc, d) => ({
          calls: acc.calls + d.calls,
          answered: acc.answered + d.answered,
          talk: acc.talk + d.talk,
          missed: acc.missed + d.missed,
          failed: acc.failed + d.failed,
        }),
        { calls: 0, answered: 0, talk: 0, missed: 0, failed: 0 },
      );
      const summary: DashboardSummaryDto = {
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: tz,
        calls: totals.calls,
        answered: totals.answered,
        answerRate: totals.calls
          ? Math.round((totals.answered / totals.calls) * 10_000) / 10_000
          : 0,
        minutes: Math.ceil(totals.talk / 60),
        talkSeconds: totals.talk,
        completed: totals.answered,
        missed: totals.missed,
        failed: totals.failed,
        daily: series,
      };
      return ok(summary);
    },
  );
};

/** Calendar days (YYYY-MM-DD, org timezone) touched by [from, to). */
export function localDays(from: Date, to: Date, timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const first = fmt.format(from);
  const last = fmt.format(new Date(to.getTime() - 1));
  const out: string[] = [];
  // Walk calendar dates in UTC arithmetic; only the labels matter.
  let cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor <= end && out.length < 400) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return out;
}
