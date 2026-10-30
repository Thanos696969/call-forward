import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, blocklistEntries, desc, eq, users } from '@relay/db';
import { blocklistBodySchema, type BlocklistEntryDto } from '@relay/core';
import { writeAudit } from '../lib/audit';
import { conflict, isUniqueViolation, notFound } from '../lib/errors';
import { isoReq, ok } from '../lib/http';
import { READ_ROLES, WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { assertId } from './numbers';

/** Organisation-wide blocked callers. Checked on every inbound call before anything rings. */
export const blocklistRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const { db } = deps;

  async function list(orgId: string): Promise<BlocklistEntryDto[]> {
    const rows = await db
      .select({ e: blocklistEntries, email: users.email })
      .from(blocklistEntries)
      .leftJoin(users, eq(users.id, blocklistEntries.createdBy))
      .where(eq(blocklistEntries.orgId, orgId))
      .orderBy(desc(blocklistEntries.createdAt));
    return rows.map(({ e, email }) => ({
      id: e.id,
      e164: e.e164,
      reason: e.reason,
      createdBy: email ?? null,
      createdAt: isoReq(e.createdAt),
    }));
  }

  app.get(
    '/blocklist',
    { schema: { tags: ['protection'] }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => ok(await list(authOf(req).orgId)),
  );

  app.post(
    '/blocklist',
    {
      schema: { tags: ['protection'], body: blocklistBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req, reply) => {
      const auth = authOf(req);
      try {
        await db.transaction(async (tx) => {
          const [e] = await tx
            .insert(blocklistEntries)
            .values({
              orgId: auth.orgId,
              e164: req.body.e164,
              reason: req.body.reason,
              createdBy: auth.userId,
            })
            .returning({ id: blocklistEntries.id });
          await writeAudit(tx, {
            orgId: auth.orgId,
            actorUserId: auth.userId,
            action: 'blocklist.add',
            entityType: 'blocklist_entry',
            entityId: e!.id,
            after: req.body,
            ip: req.ip,
          });
        });
      } catch (err) {
        if (isUniqueViolation(err))
          throw conflict('already_blocked', 'That number is already blocked');
        throw err;
      }
      return reply.status(201).send(ok(await list(auth.orgId)));
    },
  );

  app.delete(
    '/blocklist/:id',
    {
      schema: { tags: ['protection'], params: z.object({ id: z.string().max(64) }) },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      await db.transaction(async (tx) => {
        const rows = await tx
          .delete(blocklistEntries)
          .where(
            and(
              eq(blocklistEntries.id, assertId(req.params.id, 'Blocked number')),
              eq(blocklistEntries.orgId, auth.orgId),
            ),
          )
          .returning({ id: blocklistEntries.id, e164: blocklistEntries.e164 });
        if (!rows[0]) throw notFound('Blocked number');
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'blocklist.remove',
          entityType: 'blocklist_entry',
          entityId: rows[0].id,
          before: { e164: rows[0].e164 },
          ip: req.ip,
        });
      });
      return ok(await list(auth.orgId));
    },
  );
};
