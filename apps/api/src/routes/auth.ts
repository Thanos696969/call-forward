import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  and,
  eq,
  hashPassword,
  memberships,
  organizations,
  sessions,
  users,
  verifyPassword,
} from '@relay/db';
import {
  forgotPasswordBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  type MeDto,
} from '@relay/core';
import { generateToken, hashToken } from '@relay/core/server';
import { writeAudit } from '../lib/audit';
import { HttpError, conflict, isUniqueViolation, unauthorized } from '../lib/errors';
import { ok } from '../lib/http';
import {
  SESSION_COOKIE,
  authOf,
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
} from '../plugins/auth';
import { loadMe } from '../services/org';
import { rateLimit } from './rate-limit';

const RESET_TTL_SEC = 60 * 60;
const resetKey = (hash: string) => `pwreset:${hash}`;

/** A real Argon2id hash used to keep login timing flat when the email is unknown. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(generateToken(16)));

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'org'}-${
    generateToken(4)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 6) || 'x'
  }`;
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;

  app.get('/auth/csrf', { schema: { tags: ['auth'] } }, async (req) =>
    ok({ csrfToken: req.csrfToken ?? null }),
  );

  app.post(
    '/auth/register',
    {
      schema: { tags: ['auth'], body: registerBodySchema },
      config: rateLimit(deps, 3, '1 hour'),
    },
    async (req, reply) => {
      const body = req.body;
      const passwordHash = await hashPassword(body.password);
      let created: { orgId: string; userId: string };
      try {
        created = await deps.db.transaction(async (tx) => {
          const [org] = await tx
            .insert(organizations)
            .values({ name: body.orgName, slug: slugify(body.orgName) })
            .returning({ id: organizations.id });
          const [user] = await tx
            .insert(users)
            .values({
              email: body.email,
              passwordHash,
              name: body.name ?? null,
              lastLoginAt: new Date(),
            })
            .returning({ id: users.id });
          if (!org || !user) throw new Error('insert failed');
          await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: 'owner' });
          await writeAudit(tx, {
            orgId: org.id,
            actorUserId: user.id,
            action: 'auth.register',
            entityType: 'organization',
            entityId: org.id,
            after: { orgName: body.orgName },
            ip: req.ip,
          });
          return { orgId: org.id, userId: user.id };
        });
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_key')) {
          throw conflict('email_taken', 'An account with this email already exists');
        }
        throw err;
      }
      const session = await createSession(deps, req, created.userId, created.orgId);
      setSessionCookie(reply, deps, session.token, session.expiresAt);
      const me = await loadMe(deps, { userId: created.userId, orgId: created.orgId });
      return reply.status(201).send(ok<MeDto>(me));
    },
  );

  app.post(
    '/auth/login',
    {
      schema: { tags: ['auth'], body: loginBodySchema },
      config: rateLimit(deps, 5, '1 minute'),
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const [user] = await deps.db
        .select({ id: users.id, passwordHash: users.passwordHash, status: users.status })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
      if (!user || !valid || user.status !== 'active') {
        req.log.info({ event: 'auth.login_failed' }, 'login failed');
        throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
      }
      const [membership] = await deps.db
        .select({ orgId: memberships.orgId })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(eq(memberships.userId, user.id), eq(organizations.status, 'active')))
        .orderBy(memberships.createdAt)
        .limit(1);
      if (!membership)
        throw new HttpError(403, 'no_organization', 'This account has no active organisation');

      // Rotate: drop any session presented with this request before issuing a new one.
      await destroySession(deps, req.cookies[SESSION_COOKIE]);
      const session = await createSession(deps, req, user.id, membership.orgId);
      await deps.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await writeAudit(deps.db, {
        orgId: membership.orgId,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        ip: req.ip,
      });
      setSessionCookie(reply, deps, session.token, session.expiresAt);
      return ok<MeDto>(await loadMe(deps, { userId: user.id, orgId: membership.orgId }));
    },
  );

  app.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    await destroySession(deps, req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, deps);
    return ok({ loggedOut: true });
  });

  app.post(
    '/auth/forgot-password',
    {
      schema: { tags: ['auth'], body: forgotPasswordBodySchema },
      config: rateLimit(deps, 5, '1 hour'),
    },
    async (req) => {
      const [user] = await deps.db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.email, req.body.email))
        .limit(1);
      if (user && user.status === 'active') {
        const token = generateToken(32);
        await deps.redis.set(resetKey(hashToken(token)), user.id, 'EX', RESET_TTL_SEC);
        const link = `${deps.config.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
        try {
          await deps.mailer.send({
            to: req.body.email,
            subject: 'Reset your Relay password',
            text: `Someone asked to reset the password for this Relay account.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email.`,
          });
        } catch (err) {
          req.log.error({ err }, 'password reset email failed');
        }
      }
      // Same response whether or not the account exists (no account enumeration).
      return ok({ sent: true });
    },
  );

  app.post(
    '/auth/reset-password',
    {
      schema: { tags: ['auth'], body: resetPasswordBodySchema },
      config: rateLimit(deps, 10, '1 hour'),
    },
    async (req) => {
      const userId = await deps.redis.getdel(resetKey(hashToken(req.body.token)));
      if (!userId)
        throw new HttpError(400, 'invalid_token', 'This reset link is invalid or has expired');
      const passwordHash = await hashPassword(req.body.password);
      await deps.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(users.id, userId));
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        const [m] = await tx
          .select({ orgId: memberships.orgId })
          .from(memberships)
          .where(eq(memberships.userId, userId))
          .limit(1);
        await writeAudit(tx, {
          orgId: m?.orgId ?? null,
          actorUserId: userId,
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: userId,
          ip: req.ip,
        });
      });
      return ok({ reset: true });
    },
  );

  app.get('/me', { schema: { tags: ['auth'] }, preHandler: requireAuth(deps) }, async (req) => {
    const auth = authOf(req);
    const me = await loadMe(deps, auth).catch(() => null);
    if (!me) throw unauthorized();
    return ok<MeDto>(me);
  });
};
