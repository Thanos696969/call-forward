import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MemoryReserver,
  attestationAllows,
  effectiveWeight,
  parseAttestation,
  pickWeighted,
  planAttempt,
  randomIvrDigit,
  renderIvrPrompt,
  staticIneligibility,
} from '../src/routing/route';
import { capWindowKeys } from '../src/routing/schedule';
import type { CompiledTarget, RoutingMode } from '../src/routing/types';
import { campaign, prng, route, target } from './fixtures';

const NOW = new Date('2026-10-30T15:00:00Z');

describe('weighted pick', () => {
  it('picks by cumulative weight and skips zero weights', () => {
    expect(pickWeighted([1, 1], 0.1)).toBe(0);
    expect(pickWeighted([1, 1], 0.9)).toBe(1);
    expect(pickWeighted([0, 5, 0], 0.99)).toBe(1);
    expect(pickWeighted([0, 0], 0.5)).toBe(-1);
    expect(pickWeighted([], 0.5)).toBe(-1);
  });
  it('scales weight by concurrency headroom', () => {
    expect(effectiveWeight(100, 0, 10)).toBe(100);
    expect(effectiveWeight(100, 5, 10)).toBe(50);
    expect(effectiveWeight(100, 10, 10)).toBe(0);
  });
});

describe('static eligibility', () => {
  it('reports the first reason that applies', () => {
    expect(staticIneligibility(target({ enabled: false }), new Set(), NOW)).toBe('disabled');
    expect(staticIneligibility(target({ type: 'sip' }), new Set(), NOW)).toBe('unsupported_type');
    expect(staticIneligibility(target({ weight: 0 }), new Set(), NOW)).toBe('zero_weight');
    expect(staticIneligibility(target(), new Set(['t1']), NOW)).toBe('already_tried');
    const closed = target({
      schedule: {
        timezone: 'UTC',
        windows: [{ type: 'weekly', dayOfWeek: 1, open: '09:00', close: '10:00' }],
      },
    });
    expect(staticIneligibility(closed, new Set(), NOW)).toBe('outside_schedule');
    expect(staticIneligibility(target(), new Set(), NOW)).toBeNull();
  });
});

describe('planAttempt', () => {
  it('dials the lowest tier with an eligible target and explains the rest', async () => {
    const r = route([
      target({ id: 'a', name: 'A', priorityTier: 1, enabled: false }),
      target({ id: 'b', name: 'B', priorityTier: 2 }),
      target({ id: 'c', name: 'C', priorityTier: 3 }),
    ]);
    const plan = await planAttempt(
      r,
      { tried: new Set(), now: NOW, holder: 'CA1:1', random: 0.5 },
      new MemoryReserver(),
    );
    expect(plan).toMatchObject({ kind: 'dial', tier: 2, targets: [{ id: 'b' }] });
    expect(plan.explanation).toEqual([
      { tier: 1, targets: [{ targetId: 'a', name: 'A', verdict: 'disabled' }] },
      { tier: 2, targets: [expect.objectContaining({ targetId: 'b', verdict: 'picked' })] },
    ]);
  });

  it('fails over past capped targets and reports which cap', async () => {
    const reserver = new MemoryReserver();
    const r = route([target({ id: 'a', ccCap: 1 }), target({ id: 'b', priorityTier: 2 })]);
    const first = await planAttempt(
      r,
      { tried: new Set(), now: NOW, holder: 'CA1:1', random: 0 },
      reserver,
    );
    expect(first).toMatchObject({ kind: 'dial', targets: [{ id: 'a' }] });
    const second = await planAttempt(
      r,
      { tried: new Set(), now: NOW, holder: 'CA2:1', random: 0 },
      reserver,
    );
    expect(second).toMatchObject({ kind: 'dial', tier: 2, targets: [{ id: 'b' }] });
    expect(second.explanation[0]?.targets[0]?.verdict).toBe('cc_cap');
  });

  it('rings every eligible target in the tier in simultaneous mode', async () => {
    const r = route(
      [target({ id: 'a' }), target({ id: 'b' }), target({ id: 'c', enabled: false })],
      {
        campaign: campaign({ routingMode: 'simultaneous' }),
      },
    );
    const plan = await planAttempt(
      r,
      { tried: new Set(), now: NOW, holder: 'CA1:1', random: 0.3 },
      new MemoryReserver(),
    );
    expect(plan.kind === 'dial' && plan.targets.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('is exhausted when nothing can be dialled', async () => {
    const plan = await planAttempt(
      route([target({ enabled: false })]),
      { tried: new Set(), now: NOW, holder: 'h', random: 0 },
      new MemoryReserver(),
    );
    expect(plan.kind).toBe('exhausted');
    expect(
      (
        await planAttempt(
          route([], { campaign: null }),
          { tried: new Set(), now: NOW, holder: 'h', random: 0 },
          new MemoryReserver(),
        )
      ).kind,
    ).toBe('exhausted');
  });
});

// ── Properties ─────────────────────────────────────────────────────────────

const arbTarget = (i: number): fc.Arbitrary<CompiledTarget> =>
  fc
    .record({
      priorityTier: fc.integer({ min: 1, max: 3 }),
      weight: fc.integer({ min: 0, max: 100 }),
      enabled: fc.constantFrom(true, true, true, false),
      ccCap: fc.integer({ min: 1, max: 4 }),
      hourlyCap: fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }),
      dailyCap: fc.option(fc.integer({ min: 1, max: 40 }), { nil: null }),
      totalCap: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
    })
    .map((t) => target({ ...t, id: `t${i}`, name: `T${i}` }));

const arbTargets = fc
  .integer({ min: 1, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbTarget(i))));

describe('routing properties', () => {
  it('never exceeds any cap, never rings a target twice per call, and always respects tier order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbTargets,
        fc.constantFrom<RoutingMode>('sequential', 'simultaneous'),
        fc.integer(),
        async (targets, mode, seed) => {
          const rand = prng(seed);
          const reserver = new MemoryReserver();
          const r = route(targets, { campaign: campaign({ routingMode: mode }) });
          const open: Array<{ target: string; holder: string; until: number }> = [];
          const counts = new Map<string, number>();
          let clock = NOW.getTime();

          for (let call = 0; call < 120; call++) {
            clock += Math.floor(rand() * 30_000);
            const now = new Date(clock);
            // Calls end at random; release their reservations.
            for (let i = open.length - 1; i >= 0; i--) {
              const o = open[i]!;
              if (o.until <= clock) {
                reserver.release(o.target, o.holder);
                open.splice(i, 1);
              }
            }
            const tried = new Set<string>();
            for (let attempt = 1; attempt <= targets.length + 1; attempt++) {
              const holder = `CA${call}:${attempt}`;
              // Oracle: lowest tier holding a target that is statically eligible and under every cap.
              const ok = (t: CompiledTarget) => {
                if (staticIneligibility(t, tried, now)) return false;
                const k = capWindowKeys(t.capTimezone, now);
                const u = reserver.peek(t.id, k.hour, k.day, clock);
                return (
                  u.concurrent < t.ccCap &&
                  (t.hourlyCap === null || u.hour < t.hourlyCap) &&
                  (t.dailyCap === null || u.day < t.dailyCap) &&
                  (t.totalCap === null || u.total < t.totalCap)
                );
              };
              const expectedTier = Math.min(
                ...targets.filter(ok).map((t) => t.priorityTier),
                Infinity,
              );

              const plan = await planAttempt(r, { tried, now, holder, random: rand() }, reserver);
              if (plan.kind === 'exhausted') {
                expect(expectedTier).toBe(Infinity);
                break;
              }
              expect(plan.tier).toBe(expectedTier);
              for (const t of plan.targets) {
                expect(tried.has(t.id)).toBe(false); // no double ring
                expect(t.priorityTier).toBe(plan.tier);
                tried.add(t.id);
                counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
                open.push({ target: t.id, holder, until: clock + Math.floor(rand() * 120_000) });
              }
              // Every cap holds right after the reservation.
              for (const t of targets) {
                const k = capWindowKeys(t.capTimezone, now);
                const u = reserver.peek(t.id, k.hour, k.day, clock);
                expect(u.concurrent).toBeLessThanOrEqual(t.ccCap);
                if (t.hourlyCap !== null) expect(u.hour).toBeLessThanOrEqual(t.hourlyCap);
                if (t.dailyCap !== null) expect(u.day).toBeLessThanOrEqual(t.dailyCap);
                if (t.totalCap !== null) expect(u.total).toBeLessThanOrEqual(t.totalCap);
              }
              if (rand() < 0.5) break; // answered: no more attempts
            }
          }
          for (const t of targets)
            if (t.totalCap !== null) expect(counts.get(t.id) ?? 0).toBeLessThanOrEqual(t.totalCap);
        },
      ),
      { numRuns: 150 },
    );
  }, 120_000);

  it('distributes calls within ±3 percentage points of the configured weights', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 2, maxLength: 5 }),
        fc.integer(),
        async (weights, seed) => {
          const rand = prng(seed);
          const targets = weights.map((w, i) => target({ id: `t${i}`, weight: w, ccCap: 1000 }));
          const reserver = new MemoryReserver();
          const r = route(targets);
          const n = 20_000;
          const hits = new Map<string, number>();
          for (let i = 0; i < n; i++) {
            const holder = `CA${i}:1`;
            const plan = await planAttempt(
              r,
              { tried: new Set(), now: NOW, holder, random: rand() },
              reserver,
            );
            if (plan.kind !== 'dial') throw new Error('unexpected exhaustion');
            const id = plan.targets[0]!.id;
            hits.set(id, (hits.get(id) ?? 0) + 1);
            reserver.release(id, holder); // calls end before the next arrives: pure weight split
          }
          const total = weights.reduce((a, b) => a + b, 0);
          weights.forEach((w, i) => {
            const share = (hits.get(`t${i}`) ?? 0) / n;
            expect(Math.abs(share - w / total)).toBeLessThanOrEqual(0.03);
          });
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

describe('protection helpers', () => {
  it('parses STIR/SHAKEN results', () => {
    expect(parseAttestation('TN-Validation-Passed-A')).toBe('A');
    expect(parseAttestation('TN-Validation-Passed-C')).toBe('C');
    expect(parseAttestation('TN-Validation-Failed-B')).toBe('failed');
    expect(parseAttestation('No-TN-Validation')).toBe('none');
    expect(parseAttestation(undefined)).toBe('none');
  });
  it('applies attestation policies', () => {
    expect(attestationAllows('allow_all', 'failed')).toBe(true);
    expect(attestationAllows('block_failed', 'failed')).toBe(false);
    expect(attestationAllows('block_failed', 'none')).toBe(true);
    expect(attestationAllows('require_a_or_b', 'B')).toBe(true);
    expect(attestationAllows('require_a_or_b', 'C')).toBe(false);
    expect(attestationAllows('require_a', 'B')).toBe(false);
  });
  it('builds IVR prompts and digits', () => {
    expect(renderIvrPrompt('Press {digit} now', '4')).toBe('Press 4 now');
    expect(renderIvrPrompt('Welcome.', '4')).toBe('Welcome. Press 4 to continue.');
    expect(renderIvrPrompt(null, '7')).toContain('press 7');
    for (const r of [0, 0.5, 0.999999]) expect(randomIvrDigit(r)).toMatch(/^[1-9]$/);
  });
});
