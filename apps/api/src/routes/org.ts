import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, auditLogs, desc, eq, lt, memberships, organizations, users } from '@relay/db';
import {
  paginationQuerySchema,
  updateOrgBodySchema,
  type AuditLogDto,
  type MemberDto,
  type OrgDto,
  type Role,
} from '@relay/core';
import { writeAudit } from '../lib/audit';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { badRequest } from '../lib/errors';
import { isoReq, ok } from '../lib/http';
import { READ_ROLES, WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { getOrg, toOrgDto } from '../services/org';

export const orgRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;

  app.get(
    '/org',
    { schema: { tags: ['org'] }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => {
      const auth = authOf(req);
      return ok<OrgDto>(toOrgDto(await getOrg(deps, auth.orgId)));
    },
  );

  app.patch(
    '/org',
    {
      schema: { tags: ['org'], body: updateOrgBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const before = await getOrg(deps, auth.orgId);
      const patch: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.timezone !== undefined) patch.timezone = req.body.timezone;
      const [after] = await deps.db
        .update(organizations)
        .set(patch)
        .where(eq(organizations.id, auth.orgId))
        .returning();
      if (!after) throw badRequest('update_failed', 'Could not update organisation');
      await writeAudit(deps.db, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'org.update',
        entityType: 'organization',
        entityId: auth.orgId,
        before: { name: before.name, timezone: before.timezone },
        after: { name: after.name, timezone: after.timezone },
        ip: req.ip,
      });
      return ok<OrgDto>(toOrgDto(after));
    },
  );

  app.get(
    '/org/members',
    { schema: { tags: ['org'] }, preHandler: requireRole(deps, ...WRITE_ROLES) },
    async (req) => {
      const auth = authOf(req);
      const rows = await deps.db
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, auth.orgId))
        .orderBy(memberships.createdAt);
      return ok<MemberDto[]>(
        rows.map((r) => ({ ...r, role: r.role as Role, createdAt: isoReq(r.createdAt) })),
      );
    },
  );

  app.get(
    '/audit-logs',
    {
      schema: { tags: ['org'], querystring: paginationQuerySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const { limit, cursor } = req.query;
      const conditions = [eq(auditLogs.orgId, auth.orgId)];
      if (cursor) {
        const c = decodeCursor(cursor);
        if (!/^\d+$/.test(c.id))
          throw badRequest('invalid_cursor', 'The pagination cursor is invalid');
        conditions.push(lt(auditLogs.id, BigInt(c.id)));
      }
      const rows = await deps.db
        .select({ log: auditLogs, actorEmail: users.email })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(and(...conditions))
        .orderBy(desc(auditLogs.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const data: AuditLogDto[] = page.map(({ log, actorEmail }) => ({
        id: log.id.toString(),
        action: log.action,
        actorEmail: actorEmail ?? null,
        entityType: log.entityType,
        entityId: log.entityId,
        before: log.before,
        after: log.after,
        createdAt: isoReq(log.createdAt),
      }));
      return ok(data, {
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(isoReq(last.log.createdAt), last.log.id.toString())
            : null,
      });
    },
  );
};
