import { formatPhone } from '@relay/core';

export { formatPhone };

export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio === 0 || ratio === 1 ? 0 : 1)}%`;
}

export const OUTCOME_LABEL: Record<string, string> = {
  in_progress: 'In progress',
  completed: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  rejected: 'Not configured',
  blocked: 'Blocked',
  screened_out: 'Screened out',
  abandoned: 'Caller hung up',
};

export type Tone = 'green' | 'amber' | 'grey' | 'red' | 'blue';

export function outcomeTone(outcome: string): Tone {
  switch (outcome) {
    case 'completed':
      return 'green';
    case 'in_progress':
      return 'blue';
    case 'no_answer':
    case 'busy':
    case 'abandoned':
      return 'amber';
    default:
      return 'red';
  }
}

/** Offset (ms) of `timeZone` from UTC at instant `at`. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - at;
}

/** Local midnight of a YYYY-MM-DD date in `timeZone`, as an ISO instant. */
export function zonedMidnightIso(date: string, timeZone: string, addDays = 0): string {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + addDays);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Re-check once in case the guess and the answer straddle a DST change.
  return new Date(guess - zoneOffsetMs(first, timeZone)).toISOString();
}
