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
