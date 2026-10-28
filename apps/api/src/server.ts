import { loadEnvFile } from '@relay/core/server';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createRuntimeDeps } from './deps';

loadEnvFile();
const config = loadConfig();
const deps = await createRuntimeDeps(config);
const app = await buildApp(deps);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, 15_000);
  timer.unref();
  try {
    await app.close(); // stops accepting connections and drains in-flight requests
    await deps.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { provider: deps.provider.id, publicApiUrl: config.publicApiUrl },
    'Relay API ready',
  );
} catch (err) {
  app.log.error({ err }, 'failed to start');
  await deps.close();
  process.exit(1);
}
