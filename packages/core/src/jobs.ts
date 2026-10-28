/** Queue and job names shared by the API (producer) and the worker (consumer). */
export const CALLS_QUEUE = 'calls';
export const FINALISE_CALL_JOB = 'finalise-call';

export interface FinaliseCallPayload {
  callId: string;
}

/** BullMQ job ids must be unique per logical event; ":" is reserved by BullMQ. */
export function finaliseJobId(callId: string, outcome: string): string {
  return `finalise-${callId}-${outcome}`;
}
