import { Redis } from 'ioredis';
import { createProvider } from '@relay/core/server';
import { createDb } from '@relay/db';
import { voiceUrls, type Config } from './config';
import { createInlineCallJobs, type Defer } from './lib/inline-jobs';
import type { CallJobs } from './lib/jobs';
import { createSmtpMailer } from './lib/mailer';
import type { AppDeps } from './types';

export interface RuntimeDeps extends AppDeps {
  close(): Promise<void>;
}

const detached: Defer = (task) => {
  void task.catch(() => {});
};

export async function createRuntimeDeps(
  config: Config,
  opts: { defer?: Defer } = {},
): Promise<RuntimeDeps> {
  const defer = opts.defer ?? detached;
  const { db, sql, close: closeDb } = createDb(config.databaseUrl, { max: config.dbPoolMax });
  // Hot-path client: fail fast while disconnected so the router falls back to Postgres.
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  await redis.connect();
  let jobs: CallJobs;
  let queueRedis: Redis | null = null;
  if (config.jobsMode === 'queue') {
    // BullMQ producer connection (BullMQ manages its own retry semantics).
    queueRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    const { createCallJobs } = await import('./lib/jobs');
    jobs = createCallJobs(queueRedis);
  } else {
    jobs = createInlineCallJobs(db, defer, (err, callId) =>
      // Same shape as the API's pino lines; the maintenance sweep retries the call.
      console.error(
        JSON.stringify({
          level: 50,
          msg: 'inline finalise-call failed; the sweep will retry',
          callId,
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }
  const mailer = createSmtpMailer(config.smtp);
  const provider = createProvider(config.telephony, voiceUrls(config));

  return {
    config,
    db,
    sql,
    redis,
    provider,
    jobs,
    mailer,
    defer,
    async close() {
      await jobs.close();
      mailer.close();
      await Promise.allSettled([redis.quit(), ...(queueRedis ? [queueRedis.quit()] : [])]);
      await closeDb();
    },
  };
}
