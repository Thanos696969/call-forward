import { finaliseCall, type Database } from '@relay/db';
import type { CallJobs } from './jobs';

/** Runs work after the response has been sent (Vercel `waitUntil`, or a detached promise). */
export type Defer = (task: Promise<unknown>) => void;

/**
 * Serverless replacement for the BullMQ finalise queue: the job runs in the same function
 * invocation, after the carrier has its response. `finaliseCall` is idempotent, and calls
 * that end out of order are picked up by the maintenance sweep (`sweepUnfinalised`).
 */
export function createInlineCallJobs(
  db: Database,
  defer: Defer,
  onError: (err: unknown, callId: string) => void,
): CallJobs {
  return {
    async enqueueFinalise(callId) {
      defer(finaliseCall(db, callId).catch((err: unknown) => onError(err, callId)));
    },
    async close() {},
  };
}
