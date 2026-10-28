/**
 * Money is always integer micros held in a bigint: 1 USD = 1_000_000 micros.
 * Floats never touch money. Parsing goes through decimal strings.
 */
export type Micros = bigint;

export const MICROS_PER_UNIT = 1_000_000n;

const DECIMAL_REGEX = /^(-)?(\d+)(?:\.(\d{1,6}))?$/;

/** Parse a decimal string such as "4.99" or "-0.000125" into micros. */
export function parseMicros(decimal: string): Micros {
  const m = DECIMAL_REGEX.exec(decimal.trim());
  if (!m) throw new RangeError(`Invalid money amount: ${decimal}`);
  const [, sign, whole = '0', frac = ''] = m;
  const micros = BigInt(whole) * MICROS_PER_UNIT + BigInt(frac.padEnd(6, '0'));
  return sign ? -micros : micros;
}

/** Format micros as a fixed decimal string with the given number of places (default 2). */
export function formatMicros(micros: Micros, places = 2): string {
  if (places < 0 || places > 6) throw new RangeError('places must be 0..6');
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const step = 10n ** BigInt(6 - places);
  // Round half away from zero at the requested precision.
  const rounded = (abs + step / 2n) / step;
  const unitFactor = 10n ** BigInt(places);
  const whole = rounded / unitFactor;
  const frac = rounded % unitFactor;
  const body =
    places === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(places, '0')}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}

/**
 * Cost of a call leg: ceil(perMinute * billedSeconds / 60).
 * Rounds up to the next micro so the platform never under-charges.
 */
export function perMinuteCost(perMinuteMicros: Micros, billedSeconds: number): Micros {
  if (!Number.isInteger(billedSeconds) || billedSeconds < 0) {
    throw new RangeError('billedSeconds must be a non-negative integer');
  }
  const numerator = perMinuteMicros * BigInt(billedSeconds);
  if (numerator <= 0n) return numerator / 60n;
  return (numerator + 59n) / 60n;
}

export function sumMicros(values: readonly Micros[]): Micros {
  return values.reduce((acc, v) => acc + v, 0n);
}
