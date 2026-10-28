import type { FastifyContextConfig } from 'fastify';
import type { AppDeps } from '../types';

/** Per-route rate limit config keyed by client IP; a no-op when disabled (tests). */
export function rateLimit(deps: AppDeps, max: number, timeWindow: string): FastifyContextConfig {
  return deps.config.rateLimitEnabled
    ? { rateLimit: { max, timeWindow, keyGenerator: (req) => req.ip } }
    : { rateLimit: false };
}
