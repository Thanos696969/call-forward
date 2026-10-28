/**
 * A compiled route is everything the voice path needs to answer an inbound call
 * without touching Postgres. It is cached in Redis under `route:{e164}`.
 *
 * Phase 1 uses one phone target per number, but the shape (campaign → ordered
 * targets with tiers and weights) is the Phase 2 shape so the router extends it
 * rather than replacing it.
 */
export interface CompiledTarget {
  id: string;
  type: 'phone' | 'sip' | 'agent';
  destination: string;
  priorityTier: number;
  weight: number;
  enabled: boolean;
}

export interface CompiledRoute {
  version: 1;
  numberId: string;
  orgId: string;
  e164: string;
  orgStatus: 'active' | 'suspended' | 'closed';
  campaign: {
    id: string;
    status: 'active' | 'paused' | 'archived';
    ringTimeoutSec: number;
  } | null;
  /** Sorted by priority tier ascending, then by creation order. */
  targets: CompiledTarget[];
}

export type RouteDecision =
  | { kind: 'dial'; target: CompiledTarget; ringTimeoutSec: number; tier: number }
  | { kind: 'reject'; reason: 'not_configured' | 'org_inactive' };

/**
 * Walk priority tiers ascending and pick a target.
 *
 * Phase 1 rule: the first enabled, untried target in the lowest tier wins.
 * Phase 2 replaces `pickInTier` with the weighted, capacity-aware Lua
 * reservation; eligibility (schedules, caps) slots into `isEligible`.
 */
export function selectTarget(
  route: CompiledRoute,
  tried: ReadonlySet<string> = new Set(),
): RouteDecision {
  if (route.orgStatus !== 'active') return { kind: 'reject', reason: 'org_inactive' };
  const campaign = route.campaign;
  if (!campaign || campaign.status !== 'active')
    return { kind: 'reject', reason: 'not_configured' };

  for (const [tier, targets] of groupByTier(route.targets)) {
    const eligible = targets.filter((t) => isEligible(t, tried));
    if (eligible.length === 0) continue;
    const target = pickInTier(eligible);
    if (target) return { kind: 'dial', target, ringTimeoutSec: campaign.ringTimeoutSec, tier };
  }
  return { kind: 'reject', reason: 'not_configured' };
}

function isEligible(target: CompiledTarget, tried: ReadonlySet<string>): boolean {
  return target.enabled && target.type === 'phone' && !tried.has(target.id) && target.weight >= 0;
}

function pickInTier(eligible: CompiledTarget[]): CompiledTarget | undefined {
  return eligible[0];
}

function groupByTier(targets: CompiledTarget[]): Array<[number, CompiledTarget[]]> {
  const tiers = new Map<number, CompiledTarget[]>();
  for (const t of targets) {
    const list = tiers.get(t.priorityTier);
    if (list) list.push(t);
    else tiers.set(t.priorityTier, [t]);
  }
  return [...tiers.entries()].sort(([a], [b]) => a - b);
}
