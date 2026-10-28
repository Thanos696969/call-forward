import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { capWindowKeys } from '@relay/core';
import { MAX_LEG_SEC, keys } from './keys';

export interface ReconcileResult {
  targets: number;
  restoredHolders: number;
  removedHolders: number;
  raisedCounters: number;
}

/**
 * Re-sync Redis counters from Postgres (runs every 60 s in the worker).
 *
 * - Open legs missing from a target's live set are re-added (Redis restarted or was flushed).
 * - Holders whose leg is closed in Postgres are removed. Holders with no leg row
 *   yet are left alone: they may belong to a reservation whose leg is still being written.
 * - Hourly/daily/total counters are raised to the Postgres count when Redis is
 *   behind. Counters are never lowered, so reconciliation can only make caps stricter.
 */
export async function reconcileRouting(
  sql: Sql,
  redis: Redis,
  now = new Date(),
): Promise<ReconcileResult> {
  const targets = await sql<{ id: string; tz: string }[]>`
    select t.id, coalesce(s.timezone, o.timezone) as tz
    from targets t
    join organizations o on o.id = t.org_id
    left join schedules s on s.target_id = t.id
    where t.archived_at is null
      and exists (select 1 from call_legs l where l.target_id = t.id and l.started_at > now() - interval '3 days')`;

  let restored = 0;
  let removed = 0;
  let raised = 0;
  for (const t of targets) {
    const k = capWindowKeys(t.tz, now);
    const [counts] = await sql<{ hour: number; day: number; total: number }[]>`
      select
        count(*) filter (where to_char(started_at at time zone ${t.tz}, 'YYYYMMDDHH24') = ${k.hour})::int as hour,
        count(*) filter (where to_char(started_at at time zone ${t.tz}, 'YYYYMMDD') = ${k.day})::int as day,
        count(*)::int as total
      from call_legs where target_id = ${t.id}`;
    const legs = await sql<{ holder: string; open: boolean; expiry: Date }[]>`
      select c.provider_call_id || ':' || l.attempt as holder,
             (l.ended_at is null and l.released_at is null) as open,
             case when l.answered_at is not null then l.answered_at + make_interval(secs => ${MAX_LEG_SEC})
                  else l.started_at + make_interval(secs => coalesce(a.ring_timeout_sec, 120) + 60) end as expiry
      from call_legs l
      join calls c on c.id = l.call_id
      left join call_attempts a on a.call_id = l.call_id and a.attempt = l.attempt
      where l.target_id = ${t.id} and l.started_at > now() - make_interval(secs => ${MAX_LEG_SEC + 3600})`;

    const liveKey = keys.live(t.id);
    const members = new Set(await redis.zrange(liveKey, 0, -1));
    const pipe = redis.pipeline();
    for (const leg of legs) {
      if (leg.open && !members.has(leg.holder) && leg.expiry.getTime() > now.getTime()) {
        pipe.zadd(liveKey, 'NX', leg.expiry.getTime(), leg.holder);
        restored++;
      } else if (!leg.open && members.has(leg.holder)) {
        pipe.zrem(liveKey, leg.holder);
        removed++;
      }
    }
    const current = await redis.mget(
      keys.hour(t.id, k.hour),
      keys.day(t.id, k.day),
      keys.total(t.id),
    );
    const want = [counts?.hour ?? 0, counts?.day ?? 0, counts?.total ?? 0];
    const targetKeys = [keys.hour(t.id, k.hour), keys.day(t.id, k.day), keys.total(t.id)];
    const ttls = [7200, 3 * 86400, 0];
    want.forEach((n, i) => {
      if (Number(current[i] ?? 0) < n) {
        const key = targetKeys[i] as string;
        if (ttls[i]) pipe.set(key, n, 'EX', ttls[i] as number);
        else pipe.set(key, n);
        raised++;
      }
    });
    await pipe.exec();
  }
  return {
    targets: targets.length,
    restoredHolders: restored,
    removedHolders: removed,
    raisedCounters: raised,
  };
}
