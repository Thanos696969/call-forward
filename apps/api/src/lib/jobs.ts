import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  CALLS_QUEUE,
  FINALISE_CALL_JOB,
  finaliseJobId,
  type FinaliseCallPayload,
} from '@relay/core';

export interface CallJobs {
  enqueueFinalise(callId: string, outcome: string): Promise<void>;
  close(): Promise<void>;
}

export function createCallJobs(connection: Redis): CallJobs {
  const queue = new Queue<FinaliseCallPayload>(CALLS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  return {
    async enqueueFinalise(callId, outcome) {
      // Deterministic job id: a duplicate carrier webhook cannot enqueue twice.
      await queue.add(FINALISE_CALL_JOB, { callId }, { jobId: finaliseJobId(callId, outcome) });
    },
    close: () => queue.close(),
  };
}

/** Records enqueued jobs in memory; tests run the processor directly. */
export class MemoryCallJobs implements CallJobs {
  readonly enqueued: Array<{ callId: string; outcome: string }> = [];
  private readonly ids = new Set<string>();
  async enqueueFinalise(callId: string, outcome: string): Promise<void> {
    const id = finaliseJobId(callId, outcome);
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.enqueued.push({ callId, outcome });
  }
  async close(): Promise<void> {}
}
