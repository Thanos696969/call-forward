import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateToken, safeEqual } from '@relay/core/server';
import { HttpError } from '../lib/errors';
import type { AppDeps } from '../types';

export const CSRF_COOKIE = 'relay_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit CSRF protection for browser routes under /api/v1.
 * A readable `relay_csrf` cookie is issued on first contact; state-changing
 * requests must echo it in the `x-csrf-token` header. A cross-site attacker can
 * make the browser send the cookie but cannot read it to set the header.
 * Carrier webhooks (/voice/*) are authenticated by signature instead.
 */
export function registerCsrf(app: FastifyInstance, deps: AppDeps): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const cookie = req.cookies[CSRF_COOKIE];
    if (UNSAFE.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
        throw new HttpError(
          403,
          'csrf_failed',
          'Missing or invalid CSRF token. Reload the page and try again.',
        );
      }
    }
    req.csrfToken = cookie ?? issueCsrfCookie(reply, deps);
  });
}

export function issueCsrfCookie(reply: FastifyReply, deps: AppDeps): string {
  const token = generateToken(24);
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: deps.config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
  });
  return token;
}
