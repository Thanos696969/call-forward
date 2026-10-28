import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatMicros, parseMicros, perMinuteCost, sumMicros } from '../src/money';

describe('money (integer micros)', () => {
  it('parses decimal strings exactly', () => {
    expect(parseMicros('4.99')).toBe(4_990_000n);
    expect(parseMicros('0.000125')).toBe(125n);
    expect(parseMicros('-1.5')).toBe(-1_500_000n);
    expect(() => parseMicros('1.0000001')).toThrow();
    expect(() => parseMicros('1e3')).toThrow();
  });

  it('formats with rounding half away from zero', () => {
    expect(formatMicros(4_990_000n)).toBe('4.99');
    expect(formatMicros(4_995_000n)).toBe('5.00');
    expect(formatMicros(-4_995_000n)).toBe('-5.00');
    expect(formatMicros(125n, 6)).toBe('0.000125');
  });

  it('round-trips any 6-decimal amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), (m) => {
        expect(parseMicros(formatMicros(m, 6))).toBe(m);
      }),
    );
  });

  it('per-minute cost rounds up to the next micro', () => {
    expect(perMinuteCost(22_000n, 60)).toBe(22_000n);
    expect(perMinuteCost(22_000n, 1)).toBe(367n); // 366.67 → 367
    expect(perMinuteCost(22_000n, 0)).toBe(0n);
    expect(() => perMinuteCost(1n, 1.5)).toThrow();
  });

  it('sums', () => {
    expect(sumMicros([1n, 2n, 3n])).toBe(6n);
  });
});
