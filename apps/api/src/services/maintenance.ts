import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { REAPER_EVERY_MS, RECONCILE_EVERY_MS } from '@relay/core';
import { finaliseCall, type Database } from '@relay/db';
import { reapOrphans, reconcileRouting } from '@relay/routing';

/** Held for one reaper interval; whoever sets it runs maintenance, nobody else until it expires. */
export const MAINTENANCE_LOCK = 'maint:run';
/** Set when reconciliation ran; it runs at most once per reconcile interval. */
export const RECONCILE_MARK = 'maint:reconcile';

export interface MaintenanceDeps {
  sql: Sql;
  db: Database;
  redis: Redis;
}

export interface MaintenanceResult {
  ran: boolean;
  reaper?: Record<string, number>;
  reconcile?: Record<string, number>;
  finalised?: number;
}

/** Calls that ended but were never finalised (an inline job lost to a crash or timeout). */
export async function sweepUnfinalised(deps: MaintenanceDeps, limit = 200): Promise<number> {
  const rows = await deps.sql<{ id: string }[]>`
    select id from calls
    where outcome <> 'in_progress' and billed_seconds is null
      and coalesce(ended_at, started_at) < now() - interval '1 minute'
    order by coalesce(ended_at, started_at)
    limit ${limit}`;
  let done = 0;
  for (const r of rows) if ((await finaliseCall(deps.db, r.id)) === 'finalised') done++;
  return done;
}

/**
 * Serverless replacement for the worker's maintenance schedulers. The Redis lock keeps the
 * reaper and the reconciler from interleaving across function instances, exactly as the
 * worker's single-concurrency queue did.
 */
export async function runMaintenanceIfDue(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const lock = await deps.redis.set(MAINTENANCE_LOCK, '1', 'PX', REAPER_EVERY_MS, 'NX');
  if (lock !== 'OK') return { ran: false };
  const result: MaintenanceResult = { ran: true };
  result.reaper = { ...(await reapOrphans(deps.sql, deps.redis)) };
  const reconcileDue = await deps.redis.set(RECONCILE_MARK, '1', 'PX', RECONCILE_EVERY_MS, 'NX');
  if (reconcileDue === 'OK') {
    result.reconcile = { ...(await reconcileRouting(deps.sql, deps.redis)) };
    result.finalised = await sweepUnfinalised(deps);
  }
  return result;
}

/**
 * Piggybacks maintenance on ordinary traffic: at most one attempt per instance per reaper
 * interval, so the cost is one Redis SET every 30 s per warm instance.
 */
export class MaintenanceTicker {
  private lastAttempt = 0;
  constructor(
    private readonly deps: MaintenanceDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the maintenance run to defer, or null when this instance tried recently. */
  maybeRun(): Promise<MaintenanceResult> | null {
    const t = this.now();
    if (t - this.lastAttempt < REAPER_EVERY_MS) return null;
    this.lastAttempt = t;
    return runMaintenanceIfDue(this.deps);
  }
}
