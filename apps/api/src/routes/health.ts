import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;

  /** Liveness: the process is up and serving. */
  app.get('/healthz', { schema: { hide: true }, logLevel: 'warn' }, async () => ({ status: 'ok' }));

  /** Readiness: Postgres and Redis answer. Load balancers route traffic only when ready. */
  app.get('/readyz', { schema: { hide: true }, logLevel: 'warn' }, async (_req, reply) => {
    const checks = await Promise.allSettled([deps.sql`select 1`, deps.redis.ping()]);
    const [db, redis] = checks.map((c) => (c.status === 'fulfilled' ? 'ok' : 'error'));
    const ready = db === 'ok' && redis === 'ok';
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', checks: { db, redis } });
  });
};
