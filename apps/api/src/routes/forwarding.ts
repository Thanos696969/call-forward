import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, asc, campaigns, eq, isNull, phoneNumbers, sql, targets } from '@relay/db';
import { updateForwardingBodySchema, type NumberDto } from '@relay/core';
import { writeAudit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { getNumber } from '../services/numbers';
import { assertId, idParams } from './numbers';

/**
 * PATCH /numbers/:id — the Phase 1 forwarding form.
 * Internally: the number's campaign holds the ring timeout, and its first
 * tier-1 phone target holds the destination and the enabled flag. Phase 2
 * exposes campaigns and targets directly; this endpoint keeps working on top.
 */
export const forwardingRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;

  app.patch(
    '/numbers/:id',
    {
      schema: { tags: ['numbers'], params: idParams, body: updateForwardingBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const id = assertId(req.params.id, 'Number');
      const { forwardTo, ringTimeoutSec, enabled } = req.body;

      const e164 = await deps.db.transaction(async (tx) => {
        const [number] = await tx
          .select()
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.id, id), eq(phoneNumbers.orgId, auth.orgId)))
          .for('update')
          .limit(1);
        if (!number) throw notFound('Number');
        if (number.status !== 'active') {
          throw new HttpError(409, 'number_not_active', 'Only active numbers can forward calls');
        }
        if (forwardTo === number.e164) {
          throw new HttpError(422, 'validation_error', 'A number cannot forward to itself', [
            { path: 'forwardTo', message: 'Choose a different phone number' },
          ]);
        }

        let campaignId = number.campaignId;
        let beforeTimeout: number | null = null;
        if (campaignId) {
          // The quick form edits a campaign only while it is "simple": this number, one target.
          const [shape] = await tx.execute<{ numbers: number; targets: number }>(sql`
            select (select count(*)::int from phone_numbers where campaign_id = ${campaignId} and status <> 'released') as numbers,
                   (select count(*)::int from targets where campaign_id = ${campaignId} and archived_at is null) as targets`);
          if (shape && (shape.numbers > 1 || shape.targets > 1)) {
            throw new HttpError(
              409,
              'campaign_managed',
              'This number is routed by a campaign with several numbers or targets. Change routing on the campaign page.',
            );
          }
        }
        if (campaignId) {
          const [c] = await tx
            .select({ ringTimeoutSec: campaigns.ringTimeoutSec })
            .from(campaigns)
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, auth.orgId)));
          beforeTimeout = c?.ringTimeoutSec ?? null;
          await tx
            .update(campaigns)
            .set({ ringTimeoutSec, status: 'active', updatedAt: new Date() })
            .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, auth.orgId)));
        } else {
          const [c] = await tx
            .insert(campaigns)
            .values({ orgId: auth.orgId, name: `Forwarding — ${number.e164}`, ringTimeoutSec })
            .returning({ id: campaigns.id });
          if (!c) throw new Error('campaign insert failed');
          campaignId = c.id;
          await tx.update(phoneNumbers).set({ campaignId }).where(eq(phoneNumbers.id, number.id));
        }

        const [existing] = await tx
          .select()
          .from(targets)
          .where(
            and(
              eq(targets.campaignId, campaignId),
              eq(targets.orgId, auth.orgId),
              eq(targets.targetType, 'phone'),
              isNull(targets.archivedAt),
            ),
          )
          .orderBy(asc(targets.priorityTier), asc(targets.createdAt), asc(targets.id))
          .limit(1);
        if (existing) {
          await tx
            .update(targets)
            .set({ destination: forwardTo, enabled, updatedAt: new Date() })
            .where(eq(targets.id, existing.id));
        } else {
          await tx.insert(targets).values({
            orgId: auth.orgId,
            campaignId,
            targetType: 'phone',
            name: 'Primary destination',
            destination: forwardTo,
            weight: 100,
            priorityTier: 1,
            enabled,
          });
        }

        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'forwarding.update',
          entityType: 'phone_number',
          entityId: number.id,
          before: existing
            ? {
                forwardTo: existing.destination,
                ringTimeoutSec: beforeTimeout,
                enabled: existing.enabled,
              }
            : null,
          after: { forwardTo, ringTimeoutSec, enabled },
          ip: req.ip,
        });
        return number.e164;
      });

      await app.routeCache.invalidate(e164);
      return ok<NumberDto>(await getNumber(deps.sql, auth.orgId, id));
    },
  );
};
