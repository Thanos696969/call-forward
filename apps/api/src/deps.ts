import { Redis } from 'ioredis';
import { createProvider } from '@relay/core/server';
import { createDb } from '@relay/db';
import { voiceUrls, type Config } from './config';
import { createCallJobs } from './lib/jobs';
import { createSmtpMailer } from './lib/mailer';
import type { AppDeps } from './types';

export interface RuntimeDeps extends AppDeps {
  close(): Promise<void>;
}

export async function createRuntimeDeps(config: Config): Promise<RuntimeDeps> {
  const { db, sql, close: closeDb } = createDb(config.databaseUrl, { max: 20 });
  // Hot-path client: fail fast while disconnected so the router falls back to Postgres.
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  await redis.connect();
  // BullMQ producer connection (BullMQ manages its own retry semantics).
  const queueRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const jobs = createCallJobs(queueRedis);
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
    async close() {
      await jobs.close();
      mailer.close();
      await Promise.allSettled([redis.quit(), queueRedis.quit()]);
      await closeDb();
    },
  };
}
