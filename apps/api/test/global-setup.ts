import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { createDb, runMigrations } from '@relay/db';

let pg: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

/** One Postgres 16 + Redis 7 pair for the whole integration run (Testcontainers). */
export async function setup(project: TestProject) {
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const databaseUrl = pg.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();
  const { sql, close } = createDb(databaseUrl, { max: 1 });
  await runMigrations(sql);
  await close();
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);
}

export async function teardown() {
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
}
