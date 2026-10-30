import type { Sql, TransactionSql } from 'postgres';
import {
  effectiveWeight,
  pickWeighted,
  type CapReason,
  type ReserveRequest,
  type ReserveResult,
  type Reserver,
} from '@relay/core';

type Executor = Sql | TransactionSql;

/**
 * Fallback reserver used when Redis is unavailable. It must run inside the
 * transaction that inserts the call legs: target rows are locked `FOR UPDATE`
 * (serialising concurrent fallback reservations per target) and live usage is
 * counted from `call_legs`, so the reservation *is* the leg row the caller
 * inserts next. Slower than Redis but enforces the same caps.
 */
export class DbReserver implements Reserver {
  readonly name = 'postgres';

  constructor(private readonly tx: Executor) {}

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const ids = req.candidates.map((c) => c.target.id);
    await this.tx`select id from targets where id = any(${ids}::uuid[]) order by id for update`;
    const holderCall = req.holder.slice(0, req.holder.lastIndexOf(':'));
    const holderAttempt = Number(req.holder.slice(req.holder.lastIndexOf(':') + 1));

    const reasons: ReserveResult['reasons'] = {};
    const usage: ReserveResult['usage'] = {};
    const eligible: Array<{ id: string; weight: number }> = [];
    const mine: string[] = [];
    for (const c of req.candidates) {
      const t = c.target;
      const [row] = await this.tx<
        { concurrent: number; hour: number; day: number; total: number; mine: boolean }[]
      >`
        select
          count(*) filter (where l.ended_at is null and l.released_at is null
                             and l.started_at > now() - interval '4 hours')::int as concurrent,
          count(*) filter (where to_char(l.started_at at time zone ${t.capTimezone}, 'YYYYMMDDHH24') = ${c.hourKey})::int as hour,
          count(*) filter (where to_char(l.started_at at time zone ${t.capTimezone}, 'YYYYMMDD') = ${c.dayKey})::int as day,
          count(*)::int as total,
          bool_or(cl.provider_call_id = ${holderCall} and l.attempt = ${holderAttempt}) as mine
        from call_legs l join calls cl on cl.id = l.call_id
        where l.target_id = ${t.id}`;
      const u = row ?? { concurrent: 0, hour: 0, day: 0, total: 0, mine: false };
      usage[t.id] = { concurrent: u.concurrent, hour: u.hour, day: u.day, total: u.total };
      if (u.mine) {
        mine.push(t.id);
        reasons[t.id] = null;
        continue;
      }
      let reason: CapReason | null = null;
      if (u.concurrent >= t.ccCap) reason = 'cc_cap';
      else if (t.hourlyCap !== null && u.hour >= t.hourlyCap) reason = 'hourly_cap';
      else if (t.dailyCap !== null && u.day >= t.dailyCap) reason = 'daily_cap';
      else if (t.totalCap !== null && u.total >= t.totalCap) reason = 'total_cap';
      reasons[t.id] = reason;
      if (!reason)
        eligible.push({ id: t.id, weight: effectiveWeight(t.weight, u.concurrent, t.ccCap) });
    }
    if (mine.length > 0) return { picked: mine, reasons, usage };
    let picked: string[] = [];
    if (req.mode === 'simultaneous') picked = eligible.filter((e) => e.weight > 0).map((e) => e.id);
    else {
      const i = pickWeighted(
        eligible.map((e) => e.weight),
        req.random,
      );
      if (i >= 0 && eligible[i]) picked = [eligible[i].id];
    }
    return { picked, reasons, usage };
  }
}
