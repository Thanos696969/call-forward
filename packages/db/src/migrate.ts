import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Forward-only SQL migrations. Files run in lexical order, each in its own
 * transaction, guarded by an advisory lock so concurrent deploys don't race.
 */
export async function runMigrations(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727274)`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const rows = await tx<{ name: string }[]>`select name from schema_migrations`;
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(`${dir}/${file}`, 'utf8');
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
