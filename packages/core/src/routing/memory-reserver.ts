import {
  effectiveWeight,
  pickWeighted,
  type CapReason,
  type ReserveRequest,
  type ReserveResult,
  type Reserver,
} from './planner';

/**
 * Reference implementation of the reservation semantics, used by property tests
 * and as the executable spec the Redis Lua script and Postgres fallback must match.
 * Single-threaded, so every call is trivially atomic.
 */
export class MemoryReserver implements Reserver {
  readonly name = 'memory';
  /** targetId → holder → expiry (ms). */
  private readonly live = new Map<string, Map<string, number>>();
  private readonly counters = new Map<string, number>();

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const now = req.now.getTime();
    const reasons: ReserveResult['reasons'] = {};
    const usage: ReserveResult['usage'] = {};
    const eligible: Array<{ id: string; weight: number }> = [];
    for (const c of req.candidates) {
      const t = c.target;
      const concurrent = this.concurrent(t.id, now);
      const hour = this.counters.get(`h:${t.id}:${c.hourKey}`) ?? 0;
      const day = this.counters.get(`d:${t.id}:${c.dayKey}`) ?? 0;
      const total = this.counters.get(`t:${t.id}`) ?? 0;
      usage[t.id] = { concurrent, hour, day, total };
      let reason: CapReason | null = null;
      if (concurrent >= t.ccCap) reason = 'cc_cap';
      else if (t.hourlyCap !== null && hour >= t.hourlyCap) reason = 'hourly_cap';
      else if (t.dailyCap !== null && day >= t.dailyCap) reason = 'daily_cap';
      else if (t.totalCap !== null && total >= t.totalCap) reason = 'total_cap';
      reasons[t.id] = reason;
      if (!reason)
        eligible.push({ id: t.id, weight: effectiveWeight(t.weight, concurrent, t.ccCap) });
    }
    let picked: string[] = [];
    if (req.mode === 'simultaneous') picked = eligible.map((e) => e.id);
    else {
      const i = pickWeighted(
        eligible.map((e) => e.weight),
        req.random,
      );
      if (i >= 0 && eligible[i]) picked = [eligible[i].id];
    }
    for (const id of picked) {
      const c = req.candidates.find((x) => x.target.id === id);
      if (!c) continue;
      this.holders(id).set(req.holder, now + req.ttlSec * 1000);
      this.bump(`h:${id}:${c.hourKey}`);
      this.bump(`d:${id}:${c.dayKey}`);
      this.bump(`t:${id}`);
    }
    return { picked, reasons, usage };
  }

  /** Live usage without reserving (test oracle and dry-run explanations). */
  peek(targetId: string, hourKey: string, dayKey: string, nowMs: number) {
    return {
      concurrent: this.concurrent(targetId, nowMs),
      hour: this.counters.get(`h:${targetId}:${hourKey}`) ?? 0,
      day: this.counters.get(`d:${targetId}:${dayKey}`) ?? 0,
      total: this.counters.get(`t:${targetId}`) ?? 0,
    };
  }

  release(targetId: string, holder: string): void {
    this.holders(targetId).delete(holder);
  }

  concurrent(targetId: string, nowMs: number): number {
    const h = this.holders(targetId);
    for (const [k, exp] of h) if (exp <= nowMs) h.delete(k);
    return h.size;
  }

  private holders(id: string): Map<string, number> {
    let m = this.live.get(id);
    if (!m) {
      m = new Map();
      this.live.set(id, m);
    }
    return m;
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
}
