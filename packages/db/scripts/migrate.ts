import { loadEnvFile } from '@relay/core/server';
import { createDb, runMigrations } from '../src/index';

loadEnvFile();
const { sql, close } = createDb(undefined, { max: 1 });
try {
  const applied = await runMigrations(sql);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (err) {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
