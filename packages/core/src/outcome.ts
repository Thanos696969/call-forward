export const CALL_OUTCOMES = [
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'rejected',
  'blocked',
  'screened_out',
  'abandoned',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Outcomes counted as "missed" on the dashboard. */
export const MISSED_OUTCOMES: readonly CallOutcome[] = ['no_answer', 'busy', 'abandoned'];
/** Outcomes counted as "failed" on the dashboard. */
export const FAILED_OUTCOMES: readonly CallOutcome[] = [
  'failed',
  'rejected',
  'blocked',
  'screened_out',
];

/**
 * Map the result of a <Dial> attempt (Twilio/TeXML `DialCallStatus`) to an outcome.
 * Unknown statuses map to `failed` so a call never stays `in_progress` forever.
 */
export function mapDialStatus(status: string | undefined): Exclude<CallOutcome, 'in_progress'> {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'answered':
      return 'completed';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'canceled':
      return 'abandoned';
    case 'failed':
    default:
      return 'failed';
  }
}

const TERMINAL_PARENT_STATUSES = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);

export function isTerminalCallStatus(status: string | undefined): boolean {
  return TERMINAL_PARENT_STATUSES.has((status ?? '').toLowerCase());
}

/**
 * Map a terminal parent-call status (`CallStatus` on the status callback) to an
 * outcome. Used only when the dial result never arrived, e.g. the caller hung up
 * while the destination was still ringing. A parent call that "completed" without
 * a dial result means the caller left before anyone answered.
 */
export function mapParentStatusWithoutDialResult(
  status: string | undefined,
): Exclude<CallOutcome, 'in_progress'> | null {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'canceled':
      return 'abandoned';
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no_answer';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/** Parse a carrier duration field ("42") into non-negative whole seconds. */
export function parseDurationSeconds(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
