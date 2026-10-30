/**
 * Vercel build: apply database migrations on production deploys, then build Next.js.
 *
 * Preview deploys skip migrations unless RUN_MIGRATIONS=true, so a pull request can never
 * change the production schema before it is merged (give previews their own database,
 * e.g. a Neon preview branch, and set RUN_MIGRATIONS=true for them).
 */
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const env = process.env.VERCEL_ENV ?? 'development';
const migrate = env === 'production' || process.env.RUN_MIGRATIONS === 'true';

if (migrate) {
  if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) {
    console.error(
      'DATABASE_URL is not set. Connect a Postgres database (Vercel → Storage → Neon) to this project and redeploy.',
    );
    process.exit(1);
  }
  console.log(`Applying database migrations (${env})…`);
  run('pnpm', ['--filter', '@relay/db', 'migrate']);
} else {
  console.log(`Skipping migrations for the ${env} deploy (set RUN_MIGRATIONS=true to run them).`);
}

run('pnpm', ['exec', 'next', 'build']);
