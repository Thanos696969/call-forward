import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { inject } from 'vitest';
import { MockProvider, signMockWebhook } from '@relay/core/server';
import { createDb, type DbHandle } from '@relay/db';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { MemoryCallJobs } from '../src/lib/jobs';
import { MemoryMailer } from '../src/lib/mailer';
import type { AppDeps } from '../src/types';

export const MOCK_SECRET = 'test-mock-secret';
export const PUBLIC_URL = 'http://relay.test';

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  jobs: MemoryCallJobs;
  mailer: MemoryMailer;
  db: DbHandle;
  close(): Promise<void>;
}

export async function startHarness(
  env: Record<string, string> = {},
  opts: { random?: () => number; redis?: Redis } = {},
): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('databaseUrl'),
    REDIS_URL: inject('redisUrl'),
    RATE_LIMIT_ENABLED: 'false',
    TELEPHONY_PROVIDER: 'mock',
    MOCK_WEBHOOK_SECRET: MOCK_SECRET,
    PUBLIC_API_URL: PUBLIC_URL,
    ...env,
  });
  const db = createDb(config.databaseUrl, { max: 5 });
  const redis = opts.redis ?? new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const jobs = new MemoryCallJobs();
  const mailer = new MemoryMailer();
  const deps: AppDeps = {
    config,
    db: db.db,
    sql: db.sql,
    redis,
    provider: new MockProvider({ webhookSecret: MOCK_SECRET }),
    jobs,
    mailer,
    ...(opts.random ? { random: opts.random } : {}),
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    jobs,
    mailer,
    db,
    async close() {
      await app.close();
      redis.disconnect();
      await db.close();
    },
  };
}

let seq = 0;
export const uniqueEmail = (tag = 'user') => `${tag}-${Date.now()}-${++seq}@example.test`;

/** A browser-like client: keeps cookies and sends the CSRF header. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly app: FastifyInstance) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      const expired = c.expires instanceof Date && c.expires.getTime() < Date.now();
      if (expired || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    opts: { csrf?: boolean } = {},
  ) {
    if (!this.cookies.has('relay_csrf'))
      this.absorb(await this.app.inject({ method: 'GET', url: '/api/v1/auth/csrf' }));
    const headers: Record<string, string> = { cookie: this.cookieHeader() };
    if (method !== 'GET' && opts.csrf !== false)
      headers['x-csrf-token'] = this.cookies.get('relay_csrf') ?? '';
    const res = await this.app.inject({
      method,
      url,
      headers,
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    this.absorb(res);
    return res;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown) => this.request('POST', url, body ?? {});
  patch = (url: string, body: unknown) => this.request('PATCH', url, body);
  del = (url: string) => this.request('DELETE', url);
}

export function json<T = Record<string, unknown>>(res: LightMyRequestResponse): T {
  return res.json() as T;
}

/** Register a fresh organisation and return a signed-in client. */
export async function signUp(app: FastifyInstance, orgName = 'Test Org') {
  const client = new Client(app);
  const email = uniqueEmail();
  const res = await client.post('/api/v1/auth/register', {
    orgName,
    email,
    password: 'correct-horse-battery',
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const me = json<{ data: { org: { id: string }; user: { id: string } } }>(res).data;
  return { client, email, orgId: me.org.id, userId: me.user.id };
}

/** Buy the first available mock toll-free number. */
export async function buyNumber(client: Client, prefix = '800') {
  const avail = await client.get(`/api/v1/numbers/available?prefix=${prefix}&limit=1`);
  const e164 = json<{ data: Array<{ e164: string }> }>(avail).data[0]?.e164;
  if (!e164) throw new Error('mock inventory exhausted');
  const res = await client.post('/api/v1/numbers', { e164 });
  if (res.statusCode !== 201) throw new Error(`purchase failed: ${res.statusCode} ${res.body}`);
  return json<{ data: { id: string; e164: string } }>(res).data;
}

let callSeq = 0;
export const newCallSid = () =>
  `CA${Date.now().toString(16)}${(++callSeq).toString(16).padStart(8, '0')}`;

/** Send a carrier webhook signed like the mock provider. */
export async function voice(
  app: FastifyInstance,
  path: string,
  params: Record<string, string>,
  opts: { secret?: string; timestampSec?: number } = {},
) {
  const body = new URLSearchParams(params).toString();
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    ...signMockWebhook(opts.secret ?? MOCK_SECRET, `${PUBLIC_URL}${path}`, body, opts.timestampSec),
  };
  return app.inject({ method: 'POST', url: path, headers, payload: body });
}
