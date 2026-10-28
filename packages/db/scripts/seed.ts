import { loadEnvFile } from '@relay/core/server';
import { createDb, DEMO, seedDemo } from '../src/index';

loadEnvFile();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}
const { db, close } = createDb(undefined, { max: 1 });
try {
  const { created } = await seedDemo(db);
  console.log(created ? 'Seeded demo data.' : 'Demo data already present.');
  console.log(`  Login:  ${DEMO.email} / ${DEMO.password}`);
  console.log(`  Number: ${DEMO.number} → ${DEMO.destination}`);
} catch (err) {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
