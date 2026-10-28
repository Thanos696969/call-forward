/**
 * Phase 1 placeholder: billed seconds equal talk seconds.
 * Phase 3 replaces this with per-org increments (default 60/60) via
 * `billedSecondsWithIncrement`, which is implemented and tested now so the
 * switch is a one-line change in the finalise job.
 */
export function billedSecondsPlaceholder(talkSeconds: number | null | undefined): number {
  if (talkSeconds === null || talkSeconds === undefined) return 0;
  if (!Number.isFinite(talkSeconds) || talkSeconds <= 0) return 0;
  return Math.floor(talkSeconds);
}

/** billed = ceil(max(talk, 1) / increment) * increment, with a minimum charge. */
export function billedSecondsWithIncrement(
  talkSeconds: number,
  incrementSeconds = 60,
  minimumSeconds = 60,
): number {
  if (talkSeconds <= 0) return 0;
  if (incrementSeconds <= 0) throw new RangeError('incrementSeconds must be positive');
  const billed = Math.ceil(Math.max(talkSeconds, 1) / incrementSeconds) * incrementSeconds;
  return Math.max(billed, minimumSeconds);
}
