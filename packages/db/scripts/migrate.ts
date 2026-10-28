import { loadEnvFile } from '@relay/core/server';
import { createDb, runMigrations } from '../src/index';

loadEnvFile();

/** `docker compose up -d` returns before Postgres accepts connections; wait up to 60 s. */
async function waitForDatabase(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = createDb(undefined, { max: 1 });
    try {
      await probe.sql`select 1`;
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      process.stdout.write('Waiting for Postgres…\n');
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      await probe.close();
    }
  }
}

const { sql, close } = createDb(undefined, { max: 1 });
try {
  await waitForDatabase();
  const applied = await runMigrations(sql);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (err) {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
