import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

export const DEFAULT_DATABASE_URL = 'postgres://relay:relay@localhost:5432/relay';

export function createDb(
  url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  opts: { max?: number } = {},
): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    // Postgres bigint → JS bigint for money columns (drizzle mode: 'bigint').
    types: { bigint: postgres.BigInt },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
