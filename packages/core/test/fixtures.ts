import type { CompiledCampaign, CompiledRoute, CompiledTarget } from '../src/routing/types';

export function target(over: Partial<CompiledTarget> = {}): CompiledTarget {
  return {
    id: 't1',
    name: 'Target',
    type: 'phone',
    destination: '+14155550123',
    priorityTier: 1,
    weight: 100,
    enabled: true,
    ccCap: 10,
    hourlyCap: null,
    dailyCap: null,
    totalCap: null,
    schedule: null,
    capTimezone: 'UTC',
    ...over,
  };
}

export function campaign(over: Partial<CompiledCampaign> = {}): CompiledCampaign {
  return {
    id: 'c1',
    name: 'Campaign',
    status: 'active',
    routingMode: 'sequential',
    ringTimeoutSec: 25,
    ivr: { enabled: false, prompt: null, digit: null, randomDigit: false, timeoutSec: 8 },
    protection: { attestationPolicy: 'allow_all', perMinute: null, perHour: null },
    unavailableMessage: null,
    ...over,
  };
}

export function route(targets: CompiledTarget[], over: Partial<CompiledRoute> = {}): CompiledRoute {
  return {
    version: 2,
    numberId: 'n1',
    orgId: 'o1',
    orgTimezone: 'UTC',
    e164: '+18005550100',
    orgStatus: 'active',
    campaign: campaign(),
    targets,
    ...over,
  };
}

/** Deterministic PRNG (mulberry32) so property failures replay exactly. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
