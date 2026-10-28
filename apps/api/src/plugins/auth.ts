import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { and, eq, gt, memberships, organizations, sessions, sql } from '@relay/db';
import type { Role } from '@relay/core';
import { generateToken, hashToken } from '@relay/core/server';
import { forbidden, unauthorized } from '../lib/errors';
import type { AppDeps, AuthContext } from '../types';

export const SESSION_COOKIE = 'relay_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend the sliding expiry at most once a day to avoid a write per request. */
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export function setSessionCookie(
  reply: FastifyReply,
  deps: AppDeps,
  token: string,
  expires: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply, deps: AppDeps): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: deps.config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
  });
}

/** Create a server-side session; only the SHA-256 of the token is stored. */
export async function createSession(
  deps: AppDeps,
  req: FastifyRequest,
  userId: string,
  orgId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await deps.db.insert(sessions).values({
    id: hashToken(token),
    userId,
    orgId,
    expiresAt,
    ip: req.ip || null,
    userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
  });
  return { token, expiresAt };
}

export async function destroySession(deps: AppDeps, token: string | undefined): Promise<void> {
  if (!token) return;
  await deps.db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Resolve the session cookie into an auth context (or null). Slides the expiry. */
export async function resolveAuth(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const id = hashToken(token);
  const now = new Date();
  const rows = await deps.db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      orgId: sessions.orgId,
      expiresAt: sessions.expiresAt,
      role: memberships.role,
      orgStatus: organizations.status,
    })
    .from(sessions)
    .innerJoin(
      memberships,
      and(eq(memberships.userId, sessions.userId), eq(memberships.orgId, sessions.orgId)),
    )
    .innerJoin(organizations, eq(organizations.id, sessions.orgId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row || row.orgStatus === 'closed') return null;

  if (row.expiresAt.getTime() - now.getTime() < SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await deps.db
      .update(sessions)
      .set({ expiresAt })
      .where(and(eq(sessions.id, id), sql`${sessions.expiresAt} < ${expiresAt}`));
    setSessionCookie(reply, deps, token, expiresAt);
  }
  return { sessionId: row.sessionId, userId: row.userId, orgId: row.orgId, role: row.role };
}

/** Require a signed-in user. Populates `request.auth`. */
export function requireAuth(deps: AppDeps): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    req.auth = await resolveAuth(deps, req, reply);
    if (!req.auth) throw unauthorized();
  };
}

/** Require a signed-in user holding one of `roles` in the active organisation. */
export function requireRole(deps: AppDeps, ...roles: Role[]): preHandlerAsyncHookHandler {
  const auth = requireAuth(deps);
  return async function (req, reply) {
    await auth.call(this, req, reply);
    if (!req.auth || !roles.includes(req.auth.role)) throw forbidden();
  };
}

/** Narrow `request.auth` after a requireAuth/requireRole preHandler. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export const READ_ROLES: Role[] = ['owner', 'admin', 'member'];
export const WRITE_ROLES: Role[] = ['owner', 'admin'];
