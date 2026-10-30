import { capWindowKeys, isOpenAt } from './schedule';
import type {
  CompiledRoute,
  CompiledTarget,
  IneligibleReason,
  RoutingMode,
  TargetExplanation,
  TierExplanation,
} from './types';

/** Checks that need no live counters. Caps are checked atomically by the reserver. */
export function staticIneligibility(
  target: CompiledTarget,
  tried: ReadonlySet<string>,
  at: Date,
): IneligibleReason | null {
  if (!target.enabled) return 'disabled';
  if (target.type !== 'phone') return 'unsupported_type';
  if (target.weight <= 0) return 'zero_weight';
  if (tried.has(target.id)) return 'already_tried';
  if (!isOpenAt(target.schedule, at)) return 'outside_schedule';
  return null;
}

/** Headroom-scaled weight: a target near its concurrency cap gets proportionally fewer calls. */
export function effectiveWeight(weight: number, concurrent: number, ccCap: number): number {
  if (weight <= 0 || ccCap <= 0 || concurrent >= ccCap) return 0;
  return (weight * (ccCap - concurrent)) / ccCap;
}

/** Cumulative-weight pick with `random` in [0, 1). Returns the index, or -1 when all weights are 0. */
export function pickWeighted(weights: readonly number[], random: number): number {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return -1;
  let point = Math.min(Math.max(random, 0), 0.999999999) * total;
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i] ?? 0);
    if (w > 0 && point < w) return i;
    point -= w;
  }
  // Floating point slack: fall back to the last positive weight.
  for (let i = weights.length - 1; i >= 0; i--) if ((weights[i] ?? 0) > 0) return i;
  return -1;
}

export interface ReserveCandidate {
  target: CompiledTarget;
  /** Local cap window labels, e.g. hour "2026102814", day "20261028". */
  hourKey: string;
  dayKey: string;
}

export interface ReserveRequest {
  /** Unique per leg holder: `${providerCallId}:${attempt}`. */
  holder: string;
  candidates: ReserveCandidate[];
  /** sequential → reserve one by weight; simultaneous → reserve every candidate under its caps. */
  mode: RoutingMode;
  now: Date;
  /** Reservation lifetime while ringing; extended when the leg is answered. */
  ttlSec: number;
  /** Uniform random in [0, 1) for the weighted pick (injected so tests are deterministic). */
  random: number;
}

export type CapReason = Extract<
  IneligibleReason,
  'cc_cap' | 'hourly_cap' | 'daily_cap' | 'total_cap'
>;

export interface ReserveResult {
  picked: string[];
  /** Per candidate: the cap that blocked it, or null if it was eligible. */
  reasons: Record<string, CapReason | null>;
  usage: Record<string, { concurrent: number; hour: number; day: number; total: number }>;
}

/** Atomic check-and-reserve against live counters (Redis Lua in production, Postgres as fallback). */
export interface Reserver {
  readonly name: string;
  reserve(req: ReserveRequest): Promise<ReserveResult>;
}

export type AttemptPlan =
  | {
      kind: 'dial';
      tier: number;
      mode: RoutingMode;
      ringTimeoutSec: number;
      targets: CompiledTarget[];
      explanation: TierExplanation[];
    }
  | { kind: 'exhausted'; explanation: TierExplanation[] };

export function groupByTier(targets: readonly CompiledTarget[]): Array<[number, CompiledTarget[]]> {
  const tiers = new Map<number, CompiledTarget[]>();
  for (const t of targets) {
    const list = tiers.get(t.priorityTier);
    if (list) list.push(t);
    else tiers.set(t.priorityTier, [t]);
  }
  return [...tiers.entries()].sort(([a], [b]) => a - b);
}

/**
 * Plan one dial attempt: walk priority tiers ascending; within a tier keep the
 * statically eligible targets, then let the reserver atomically apply caps and
 * pick by weight (sequential) or take every target with headroom (simultaneous).
 * A tier is skipped only when no target in it can be reserved.
 */
export async function planAttempt(
  route: CompiledRoute,
  opts: { tried: ReadonlySet<string>; now: Date; holder: string; random: number },
  reserver: Reserver,
): Promise<AttemptPlan> {
  const campaign = route.campaign;
  const explanation: TierExplanation[] = [];
  if (!campaign) return { kind: 'exhausted', explanation };

  for (const [tier, targets] of groupByTier(route.targets)) {
    const tierExplanation: TierExplanation = { tier, targets: [] };
    explanation.push(tierExplanation);
    const candidates: ReserveCandidate[] = [];
    for (const target of targets) {
      const reason = staticIneligibility(target, opts.tried, opts.now);
      if (reason) {
        tierExplanation.targets.push({ targetId: target.id, name: target.name, verdict: reason });
      } else {
        const keys = capWindowKeys(target.capTimezone, opts.now);
        candidates.push({ target, hourKey: keys.hour, dayKey: keys.day });
      }
    }
    if (candidates.length === 0) continue;

    const result = await reserver.reserve({
      holder: opts.holder,
      candidates,
      mode: campaign.routingMode,
      now: opts.now,
      ttlSec: campaign.ringTimeoutSec + 60,
      random: opts.random,
    });
    const picked = new Set(result.picked);
    for (const { target } of candidates) {
      const entry: TargetExplanation = {
        targetId: target.id,
        name: target.name,
        verdict: picked.has(target.id) ? 'picked' : (result.reasons[target.id] ?? 'not_picked'),
      };
      const usage = result.usage[target.id];
      if (usage) entry.usage = usage;
      tierExplanation.targets.push(entry);
    }
    if (picked.size > 0) {
      return {
        kind: 'dial',
        tier,
        mode: campaign.routingMode,
        ringTimeoutSec: campaign.ringTimeoutSec,
        targets: candidates.map((c) => c.target).filter((t) => picked.has(t.id)),
        explanation,
      };
    }
  }
  return { kind: 'exhausted', explanation };
}
