import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { CALLS_QUEUE, FINALISE_CALL_JOB, type FinaliseCallPayload } from '@relay/core';
import { loadEnvFile } from '@relay/core/server';
import { createDb, finaliseCall } from '@relay/db';

loadEnvFile();

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker' } });
const { db, close: closeDb } = createDb(process.env.DATABASE_URL, { max: 5 });
const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const worker = new Worker<FinaliseCallPayload>(
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

worker.on('completed', (job, result) => log.info({ jobId: job.id, result }, 'job completed'));
worker.on('failed', (job, err) =>
  log.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
);
worker.on('error', (err) => log.error({ err }, 'worker error'));

log.info({ queue: CALLS_QUEUE }, 'Relay worker ready');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 15_000);
  timer.unref();
  await worker.close(); // waits for in-flight jobs
  await connection.quit();
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
