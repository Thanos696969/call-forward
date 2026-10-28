import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { selectTarget, type CompiledRoute, type CompiledTarget } from '../src/routing/route';
import { UnsafeUrlError, assertSafeWebhookUrl } from '../src/security/ssrf';

const target = (over: Partial<CompiledTarget> = {}): CompiledTarget => ({
  id: 't1',
  type: 'phone',
  destination: '+14155550123',
  priorityTier: 1,
  weight: 100,
  enabled: true,
  ...over,
});

const route = (targets: CompiledTarget[], over: Partial<CompiledRoute> = {}): CompiledRoute => ({
  version: 1,
  numberId: 'n1',
  orgId: 'o1',
  e164: '+18005550100',
  orgStatus: 'active',
  campaign: { id: 'c1', status: 'active', ringTimeoutSec: 25 },
  targets,
  ...over,
});

describe('selectTarget (Phase 1 tier walk)', () => {
  it('dials the first enabled target', () => {
    expect(selectTarget(route([target()]))).toMatchObject({
      kind: 'dial',
      target: { id: 't1' },
      ringTimeoutSec: 25,
    });
  });
  it('rejects when nothing is configured or enabled', () => {
    expect(selectTarget(route([]))).toEqual({ kind: 'reject', reason: 'not_configured' });
    expect(selectTarget(route([target({ enabled: false })]))).toEqual({
      kind: 'reject',
      reason: 'not_configured',
    });
    expect(selectTarget(route([target()], { campaign: null }))).toEqual({
      kind: 'reject',
      reason: 'not_configured',
    });
    expect(
      selectTarget(
        route([target()], { campaign: { id: 'c', status: 'paused', ringTimeoutSec: 25 } }),
      ),
    ).toEqual({ kind: 'reject', reason: 'not_configured' });
    expect(selectTarget(route([target()], { orgStatus: 'suspended' }))).toEqual({
      kind: 'reject',
      reason: 'org_inactive',
    });
  });
  it('skips tried targets and walks tiers in ascending order', () => {
    const r = route([target({ id: 'a', priorityTier: 2 }), target({ id: 'b', priorityTier: 1 })]);
    expect(selectTarget(r)).toMatchObject({ target: { id: 'b' }, tier: 1 });
    expect(selectTarget(r, new Set(['b']))).toMatchObject({ target: { id: 'a' }, tier: 2 });
    expect(selectTarget(r, new Set(['a', 'b']))).toEqual({
      kind: 'reject',
      reason: 'not_configured',
    });
  });
  it('property: only ever picks an enabled, untried phone target from the lowest eligible tier', () => {
    const arbTarget: fc.Arbitrary<CompiledTarget> = fc.record({
      id: fc.uuid(),
      type: fc.constantFrom('phone' as const, 'sip' as const, 'agent' as const),
      destination: fc.constant<string>('+14155550123'),
      priorityTier: fc.integer({ min: 1, max: 4 }),
      weight: fc.integer({ min: 0, max: 100 }),
      enabled: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(arbTarget, { maxLength: 8 }),
        fc.array(fc.nat(7)),
        (targets, triedIdx) => {
          const tried = new Set(
            triedIdx.map((i) => targets[i]?.id).filter((x): x is string => !!x),
          );
          const d = selectTarget(route(targets), tried);
          const eligible = targets.filter(
            (t) => t.enabled && t.type === 'phone' && !tried.has(t.id),
          );
          if (eligible.length === 0) return d.kind === 'reject';
          const minTier = Math.min(...eligible.map((t) => t.priorityTier));
          return (
            d.kind === 'dial' && eligible.includes(d.target) && d.target.priorityTier === minTier
          );
        },
      ),
    );
  });
});

describe('SSRF guard (stub for Phase 4)', () => {
  it('allows public HTTPS URLs', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com/relay').hostname).toBe(
      'hooks.example.com',
    );
  });
  it.each([
    'http://hooks.example.com',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://169.254.169.254/latest',
    'https://[::1]/x',
    'https://user:pw@example.com',
    'not a url',
  ])('blocks %s', (u) => {
    expect(() => assertSafeWebhookUrl(u)).toThrow(UnsafeUrlError);
  });
});
