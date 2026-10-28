import { loadEnvFile } from '@relay/core/server';
import { createDb } from '../src/index';

loadEnvFile();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database with NODE_ENV=production.');
  process.exit(1);
}
const { sql, close } = createDb(undefined, { max: 1 });
try {
  await sql.unsafe('drop schema public cascade; create schema public;');
  console.log('Dropped and recreated schema "public".');
} finally {
  await close();
}
