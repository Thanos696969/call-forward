import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import {
  CALLS_QUEUE,
  FINALISE_CALL_JOB,
  MAINTENANCE_QUEUE,
  REAPER_EVERY_MS,
  REAPER_JOB,
  RECONCILE_EVERY_MS,
  RECONCILE_JOB,
  type FinaliseCallPayload,
} from '@relay/core';
import { loadEnvFile } from '@relay/core/server';
import { createDb, finaliseCall } from '@relay/db';
import { reapOrphans, reconcileRouting } from '@relay/routing';

loadEnvFile();

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker' } });
const { db, sql, close: closeDb } = createDb(process.env.DATABASE_URL, { max: 5 });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
/** Separate client for routing state, so maintenance never queues behind BullMQ's blocking reads. */
const state = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

const calls = new Worker<FinaliseCallPayload>(
  CALLS_QUEUE,
  async (job) => {
    if (job.name !== FINALISE_CALL_JOB) {
      log.warn({ job: job.name }, 'unknown job; skipping');
      return 'skipped';
    }
    const result = await finaliseCall(db, job.data.callId);
    if (result === 'not_ready') {
      // The call is still in progress (status arrived out of order); let BullMQ retry with backoff.
      throw new Error(`call ${job.data.callId} is not finished yet`);
    }
    return result;
  },
  { connection, concurrency: 10 },
);

const maintenance = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === REAPER_JOB) return reapOrphans(sql, state);
    if (job.name === RECONCILE_JOB) return reconcileRouting(sql, state);
    return 'skipped';
  },
  // One at a time: the reaper and reconciler must not interleave on the same keys.
  { connection, concurrency: 1 },
);

// Idempotent: every worker instance upserts the same schedulers.
const scheduler = new Queue(MAINTENANCE_QUEUE, { connection });
await scheduler.upsertJobScheduler(
  REAPER_JOB,
  { every: REAPER_EVERY_MS },
  { name: REAPER_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
);
await scheduler.upsertJobScheduler(
  RECONCILE_JOB,
  { every: RECONCILE_EVERY_MS },
  { name: RECONCILE_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
);

for (const w of [calls, maintenance]) {
  w.on('failed', (job, err) =>
    log.warn(
      {
        queue: w.name,
        job: job?.name,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        err: err.message,
      },
      'job failed',
    ),
  );
  w.on('error', (err) => log.error({ err, queue: w.name }, 'worker error'));
}
calls.on('completed', (job, result) => log.info({ jobId: job.id, result }, 'call finalised'));
maintenance.on('completed', (job, result) => {
  const r = result as Record<string, number> | string;
  const busy =
    typeof r === 'object' && Object.entries(r).some(([k, v]) => k !== 'targets' && v > 0);
  // Quiet unless something was actually repaired.
  if (busy) log.info({ job: job.name, result: r }, 'routing maintenance repaired state');
});

log.info({ queues: [CALLS_QUEUE, MAINTENANCE_QUEUE] }, 'Relay worker ready');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 15_000);
  timer.unref();
  await Promise.all([calls.close(), maintenance.close()]); // waits for in-flight jobs
  await scheduler.close();
  await Promise.allSettled([connection.quit(), state.quit()]);
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
