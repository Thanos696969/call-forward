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

/**
 * Transaction-mode poolers (Neon's `-pooler` host, PgBouncer, Supabase's port 6543) cannot
 * keep prepared statements across transactions, so statements are sent unprepared there.
 */
export function isPooledUrl(url: string): boolean {
  return /-pooler\.|pgbouncer=true|:6543\//.test(url);
}

export function createDb(
  url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  opts: { max?: number; prepare?: boolean } = {},
): DbHandle {
  const prepare = opts.prepare ?? !isPooledUrl(url);
  const common = { idle_timeout: 30, connect_timeout: 10, prepare, onnotice: () => {} } as const;
  const max = opts.max ?? 10;
  // Drizzle installs its own date parsers on the client it wraps, so raw SQL gets a
  // separate client that returns native Date and BigInt values.
  const drizzleClient = postgres(url, { ...common, max });
  const sql = postgres(url, { ...common, max, types: { bigint: postgres.BigInt } });
  const db = drizzle(drizzleClient, { schema });
  return {
    db,
    sql,
    close: async () => {
      await Promise.all([drizzleClient.end({ timeout: 5 }), sql.end({ timeout: 5 })]);
    },
  };
}
