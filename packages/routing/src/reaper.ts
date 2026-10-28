import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { MAX_LEG_SEC, keys } from './keys';

export interface ReapResult {
  closedLegs: number;
  releasedLegs: number;
  staleCalls: number;
  prunedHolders: number;
}

/**
 * Orphan reaper (runs every 30 s in the worker).
 *
 * 1. Legs still open after the carrier should have reported them (ringing past
 *    ring timeout + 90 s without an answer, or held past 4 h, or their call has
 *    ended) are closed in Postgres.
 * 2. Every closed leg whose slot was never released has its Redis holder removed.
 * 3. Calls stuck `in_progress` for 4 h are failed.
 * 4. Expired holders are pruned from every live-leg set.
 */
export async function reapOrphans(sql: Sql, redis: Redis, now = new Date()): Promise<ReapResult> {
  const closed = await sql<{ id: string }[]>`
    update call_legs l set
      ended_at = now(),
      outcome = coalesce(l.outcome, case when c.ended_at is not null then 'abandoned' else 'failed' end)
    from calls c, call_attempts a
    where l.call_id = c.id and a.call_id = l.call_id and a.attempt = l.attempt
      and l.ended_at is null
      and (
        c.ended_at is not null
        or (l.answered_at is null and l.started_at < ${now}::timestamptz - make_interval(secs => a.ring_timeout_sec + 90))
        or l.started_at < ${now}::timestamptz - make_interval(secs => ${MAX_LEG_SEC})
      )
    returning l.id`;

  const toRelease = await sql<{ id: string; target_id: string; holder: string }[]>`
    select l.id, l.target_id, c.provider_call_id || ':' || l.attempt as holder
    from call_legs l join calls c on c.id = l.call_id
    where l.ended_at is not null and l.released_at is null and l.target_id is not null
    limit 5000`;
  if (toRelease.length > 0) {
    const pipe = redis.pipeline();
    for (const r of toRelease) pipe.zrem(keys.live(r.target_id), r.holder);
    await pipe.exec();
    await sql`update call_legs set released_at = now() where id = any(${toRelease.map((r) => r.id)}::uuid[])`;
  }

  const stale = await sql<{ id: string }[]>`
    update calls set outcome = 'failed', ended_at = coalesce(ended_at, now()), hangup_cause = coalesce(hangup_cause, 'reaped'),
      metadata = metadata || '{"outcomeSource":"reaper"}'::jsonb
    where outcome = 'in_progress' and started_at < ${now}::timestamptz - make_interval(secs => ${MAX_LEG_SEC})
    returning id`;

  let pruned = 0;
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.livePattern, 'COUNT', 500);
    cursor = next;
    if (found.length > 0) {
      const pipe = redis.pipeline();
      for (const k of found) pipe.zremrangebyscore(k, '-inf', now.getTime());
      const res = (await pipe.exec()) ?? [];
      for (const [, n] of res) pruned += Number(n ?? 0);
    }
  } while (cursor !== '0');

  return {
    closedLegs: closed.length,
    releasedLegs: toRelease.length,
    staleCalls: stale.length,
    prunedHolders: pruned,
  };
}
