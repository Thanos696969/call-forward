import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import type { CompiledRoute, CompiledTarget } from '@relay/core';
import type { FastifyBaseLogger } from 'fastify';

export const ROUTE_CACHE_TTL_SEC = 60;
const key = (e164: string) => `route:${e164}`;

interface RouteRow {
  number_id: string;
  org_id: string;
  e164: string;
  org_status: CompiledRoute['orgStatus'];
  campaign_id: string | null;
  campaign_status: 'active' | 'paused' | 'archived' | null;
  ring_timeout_sec: number | null;
  targets: CompiledTarget[] | null;
}

/**
 * Hot-path projection of a number's routing config. Postgres is the source of
 * truth; Redis holds a 60 s copy. If Redis is unavailable the router reads
 * Postgres directly rather than failing the call.
 */
export class RouteCache {
  constructor(
    private readonly redis: Redis,
    private readonly sql: Sql,
    private readonly log: FastifyBaseLogger,
  ) {}

  async get(e164: string): Promise<CompiledRoute | null> {
    try {
      const cached = await this.redis.get(key(e164));
      if (cached) return JSON.parse(cached) as CompiledRoute;
    } catch (err) {
      this.log.warn({ err }, 'route cache read failed; falling back to database');
    }
    const route = await this.compile(e164);
    if (route) {
      try {
        await this.redis.set(key(e164), JSON.stringify(route), 'EX', ROUTE_CACHE_TTL_SEC);
      } catch (err) {
        this.log.warn({ err }, 'route cache write failed');
      }
    }
    return route;
  }

  async invalidate(e164: string): Promise<void> {
    try {
      await this.redis.del(key(e164));
    } catch (err) {
      // A stale entry expires within the TTL; log loudly so it is visible.
      this.log.error({ err }, 'route cache invalidation failed');
    }
  }

  async compile(e164: string): Promise<CompiledRoute | null> {
    const rows = await this.sql<RouteRow[]>`
      select pn.id as number_id, pn.org_id, pn.e164, o.status as org_status,
             c.id as campaign_id, c.status as campaign_status, c.ring_timeout_sec,
             (
               select coalesce(json_agg(json_build_object(
                 'id', t.id, 'type', t.target_type, 'destination', t.destination,
                 'priorityTier', t.priority_tier, 'weight', t.weight, 'enabled', t.enabled
               ) order by t.priority_tier, t.created_at, t.id), '[]'::json)
               from targets t where t.campaign_id = c.id
             ) as targets
      from phone_numbers pn
      join organizations o on o.id = pn.org_id
      left join campaigns c on c.id = pn.campaign_id
      where pn.e164 = ${e164} and pn.status = 'active'
      limit 1`;
    const row = rows[0];
    if (!row) return null;
    return {
      version: 1,
      numberId: row.number_id,
      orgId: row.org_id,
      e164: row.e164,
      orgStatus: row.org_status,
      campaign:
        row.campaign_id && row.campaign_status
          ? {
              id: row.campaign_id,
              status: row.campaign_status,
              ringTimeoutSec: row.ring_timeout_sec ?? 25,
            }
          : null,
      targets: row.targets ?? [],
    };
  }
}
