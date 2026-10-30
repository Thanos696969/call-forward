/**
 * Runs the Fastify API inside another server's request handler — the Next.js app on Vercel —
 * instead of on its own port. The app is built once per function instance and kept warm
 * between invocations; requests are handed over with `inject`, so routing, validation,
 * sessions, CSRF and signature checks are exactly the same code as the standalone server.
 */
import { waitUntil } from '@vercel/functions';
import type { FastifyInstance } from 'fastify';
import { loadEnvFile } from '@relay/core/server';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createRuntimeDeps } from './deps';

let instance: Promise<FastifyInstance> | null = null;

/** Outside Vercel `waitUntil` has no request context; the promise simply runs detached. */
function defer(task: Promise<unknown>): void {
  waitUntil(task.catch(() => {}));
}

async function boot(): Promise<FastifyInstance> {
  loadEnvFile();
  const config = loadConfig();
  const deps = await createRuntimeDeps(config, { defer });
  const app = await buildApp(deps);
  await app.ready();
  app.log.info({ provider: deps.provider.id, jobs: config.jobsMode }, 'Relay API ready (embedded)');
  return app;
}

function getApp(): Promise<FastifyInstance> {
  if (!instance) {
    instance = boot().catch((err: unknown) => {
      instance = null; // let the next request retry a failed cold start
      throw err;
    });
  }
  return instance;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);
type InjectMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
const METHODS = new Set<string>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Handles one Web `Request` with the embedded API and returns its `Response`. */
export async function handleApiRequest(request: Request): Promise<Response> {
  let app: FastifyInstance;
  try {
    app = await getApp();
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 60,
        msg: 'Relay API failed to start',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: { code: 'unavailable', message: 'The service is starting or misconfigured.' } },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!METHODS.has(method)) return new Response(null, { status: 405 });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());

  const res = await app.inject({
    method: method as InjectMethod,
    url: url.pathname + url.search,
    headers,
    ...(body && body.length > 0 ? { payload: body } : {}),
    // Loopback is a trusted proxy (TRUST_PROXY default), so Fastify takes the client IP from
    // X-Forwarded-For, which Vercel sets and overwrites on every request.
    remoteAddress: '127.0.0.1',
  });

  const out = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) for (const v of value) out.append(key, String(v));
    else out.set(key, String(value));
  }
  const empty = res.statusCode === 204 || res.statusCode === 304 || method === 'HEAD';
  return new Response(empty ? null : new Uint8Array(res.rawPayload), {
    status: res.statusCode,
    headers: out,
  });
}
