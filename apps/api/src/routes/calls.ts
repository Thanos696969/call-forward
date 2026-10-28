import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  FAILED_OUTCOMES,
  MISSED_OUTCOMES,
  dashboardQuerySchema,
  listCallsQuerySchema,
  type CallDetailDto,
  type CallDto,
  type DashboardSummaryDto,
} from '@relay/core';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { badRequest, notFound } from '../lib/errors';
import { iso, isoReq, ok } from '../lib/http';
import { READ_ROLES, authOf, requireRole } from '../plugins/auth';
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
        })[]
      >`
        select c.id, c.number_id, c.to_e164, c.from_e164,
               coalesce(t.destination, c.metadata->>'destination') as destination,
               c.started_at, c.answered_at, c.ended_at, c.ring_seconds, c.talk_seconds,
               c.billed_seconds, c.outcome, c.provider, c.provider_call_id, c.hangup_cause, c.metadata
        from calls c
        left join targets t on t.id = c.target_id and t.org_id = c.org_id
        where c.org_id = ${auth.orgId} and c.id = ${id}`;
      if (!row) throw notFound('Call');
      const legs = await sql<
        {
          id: string;
          attempt: number;
          destination: string | null;
          started_at: Date;
          answered_at: Date | null;
          ended_at: Date | null;
          outcome: string | null;
          sip_code: number | null;
        }[]
      >`
        select l.id, l.attempt, t.destination, l.started_at, l.answered_at, l.ended_at, l.outcome, l.sip_code
        from call_legs l
        join calls c on c.id = l.call_id and c.org_id = ${auth.orgId}
        left join targets t on t.id = l.target_id and t.org_id = c.org_id
        where l.call_id = ${id}
        order by l.attempt`;
      const dto: CallDetailDto = {
        ...toCallDto(row),
        providerCallId: row.provider_call_id,
        hangupCause: row.hangup_cause,
        metadata: row.metadata,
        legs: legs.map((l) => ({
          id: l.id,
          attempt: l.attempt,
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
