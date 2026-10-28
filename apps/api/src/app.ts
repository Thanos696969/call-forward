import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { HttpError } from './lib/errors';
import { registerCsrf } from './plugins/csrf';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { orgRoutes } from './routes/org';
import { RouteCache } from './services/route-cache';
import type { AppDeps } from './types';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-csrf-token"]',
          'req.headers["x-twilio-signature"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.token',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy: deps.config.trustProxy.length > 0 ? deps.config.trustProxy : false,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('deps', deps);
  app.decorate('routeCache', new RouteCache(deps.redis, deps.sql, app.log));
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Carrier webhooks are form-encoded; keep the raw body for signature checks.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = raw;
      done(null, Object.fromEntries(new URLSearchParams(raw)));
    },
  );

  await app.register(helmet, {
    // The API serves JSON and TwiML only; CSP is relaxed in development for /docs.
    contentSecurityPolicy: deps.config.isProd ? undefined : false,
  });
  await app.register(cors, {
    origin: [deps.config.webOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: 'rl:http:',
    skipOnError: true,
    enableDraftSpec: true,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`,
    }),
  });

  if (!deps.config.isProd) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Relay API',
          version: '1.0.0',
          description: 'Relay call forwarding API (Phase 1).',
        },
        servers: [{ url: deps.config.publicApiUrl }],
        components: {
          securitySchemes: {
            session: { type: 'apiKey', in: 'cookie', name: 'relay_session' },
            csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  registerCsrf(app, deps);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'Some fields are invalid',
          details: err.validation.map((v) => ({
            path: v.instancePath.replace(/^\//, '').replace(/\//g, '.'),
            message: v.message,
          })),
        },
      });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: err.message } });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: err.code?.toLowerCase() ?? 'bad_request', message: err.message },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send({
        error: {
          code: 'not_found',
          message: `No route for ${req.method} ${req.url.split('?')[0]}`,
        },
      });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1' });
  await app.register(orgRoutes, { prefix: '/api/v1' });

  return app;
}
