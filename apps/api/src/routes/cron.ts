import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { runMaintenanceIfDue } from '../services/maintenance';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Vercel Cron target. Vercel sends `Authorization: Bearer $CRON_SECRET`; without a configured
 * secret the route answers 404, so it can never be triggered anonymously.
 */
export const cronRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  app.get('/api/cron/maintenance', { schema: { hide: true } }, async (req, reply) => {
    const secret = deps.config.cronSecret;
    if (!secret)
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    const header = req.headers.authorization ?? '';
    if (!sameSecret(header, `Bearer ${secret}`))
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Unauthorized' } });
    const result = await runMaintenanceIfDue({ sql: deps.sql, db: deps.db, redis: deps.redis });
    return { data: result };
  });
};
