import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import type { Role } from '@relay/core';
import type { TelephonyProvider } from '@relay/core/server';
import type { Database } from '@relay/db';
import type { Config } from './config';
import type { CallJobs } from './lib/jobs';
import type { Mailer } from './lib/mailer';
import type { RouteCache } from './services/route-cache';

export interface AppDeps {
  config: Config;
  db: Database;
  sql: Sql;
  redis: Redis;
  provider: TelephonyProvider;
  jobs: CallJobs;
  mailer: Mailer;
}

export interface AuthContext {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    routeCache: RouteCache;
  }
  interface FastifyRequest {
    /** Raw body for form-encoded carrier webhooks (needed for signature checks). */
    rawBody?: string;
    auth: AuthContext | null;
    /** CSRF token for this browser (existing cookie or one issued on this response). */
    csrfToken?: string;
  }
}
