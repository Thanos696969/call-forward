import { createDb, runMigrations } from '@relay/db';

/** Make sure the schema exists before the servers start serving the journey. */
export default async function globalSetup() {
  const { sql, close } = createDb(process.env.DATABASE_URL, { max: 1 });
  try {
    await runMigrations(sql);
  } finally {
    await close();
  }
}
