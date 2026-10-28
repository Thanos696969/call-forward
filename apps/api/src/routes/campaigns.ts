import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  campaigns,
  eq,
  isNull,
  phoneNumbers,
  scheduleWindows,
  schedules,
  targets,
} from '@relay/db';
import {
  attachNumberBodySchema,
  createCampaignBodySchema,
  explainBodySchema,
  scheduleBodySchema,
  targetBodySchema,
  updateCampaignBodySchema,
  updateTargetBodySchema,
  validateWindows,
  type CampaignDto,
  type CampaignSummaryDto,
  type ExplainDto,
} from '@relay/core';
import { writeAudit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { READ_ROLES, WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { explainCampaign, getCampaign, listCampaigns } from '../services/campaigns';
import { assertId } from './numbers';

const campaignParams = z.object({ id: z.string().max(64) });
const targetParams = campaignParams.extend({ targetId: z.string().max(64) });
const numberParams = campaignParams.extend({ numberId: z.string().max(64) });

export const campaignRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const { db, sql } = deps;

  /** Load a campaign row for mutation, org-scoped and locked. */
  async function lockCampaign(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orgId: string,
    id: string,
  ) {
    const [c] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, assertId(id, 'Campaign')), eq(campaigns.orgId, orgId)))
      .for('update')
      .limit(1);
    if (!c) throw notFound('Campaign');
    return c;
  }

  const refresh = (campaignId: string) => app.routeCache.invalidateCampaign(campaignId);
  const detail = (orgId: string, id: string) => getCampaign(sql, app.reserver, orgId, id);

  // ── Campaigns ────────────────────────────────────────────────────────────

  app.get(
    '/campaigns',
    { schema: { tags: ['campaigns'] }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => {
      return ok<CampaignSummaryDto[]>(await listCampaigns(sql, authOf(req).orgId));
    },
  );

  app.post(
    '/campaigns',
    {
      schema: { tags: ['campaigns'], body: createCampaignBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req, reply) => {
      const auth = authOf(req);
      const id = await db.transaction(async (tx) => {
        const [c] = await tx
          .insert(campaigns)
          .values({
            orgId: auth.orgId,
            name: req.body.name,
            routingMode: req.body.routingMode,
            ringTimeoutSec: req.body.ringTimeoutSec,
          })
          .returning({ id: campaigns.id });
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'campaign.create',
          entityType: 'campaign',
          entityId: c!.id,
          after: req.body,
          ip: req.ip,
        });
        return c!.id;
      });
      return reply.status(201).send(ok<CampaignDto>(await detail(auth.orgId, id)));
    },
  );

  app.get(
    '/campaigns/:id',
    {
      schema: { tags: ['campaigns'], params: campaignParams },
      preHandler: requireRole(deps, ...READ_ROLES),
    },
    async (req) =>
      ok<CampaignDto>(await detail(authOf(req).orgId, assertId(req.params.id, 'Campaign'))),
  );

  app.patch(
    '/campaigns/:id',
    {
      schema: { tags: ['campaigns'], params: campaignParams, body: updateCampaignBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const b = req.body;
      const detached = await db.transaction(async (tx) => {
        const before = await lockCampaign(tx, auth.orgId, req.params.id);
        const onlyStatus = Object.keys(b).length === 1 && b.status !== undefined;
        if (before.status === 'archived' && !onlyStatus) {
          throw new HttpError(
            409,
            'campaign_archived',
            'Restore the campaign before changing its settings',
          );
        }
        const patch: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
        if (b.name !== undefined) patch.name = b.name;
        if (b.status !== undefined) patch.status = b.status;
        if (b.routingMode !== undefined) patch.routingMode = b.routingMode;
        if (b.ringTimeoutSec !== undefined) patch.ringTimeoutSec = b.ringTimeoutSec;
        if (b.unavailableMessage !== undefined)
          patch.unavailableMessage = b.unavailableMessage || null;
        if (b.ivr?.enabled !== undefined) patch.ivrEnabled = b.ivr.enabled;
        if (b.ivr?.prompt !== undefined) patch.ivrPrompt = b.ivr.prompt || null;
        if (b.ivr?.digit !== undefined) patch.ivrDigit = b.ivr.digit;
        if (b.ivr?.randomDigit !== undefined) patch.ivrRandomDigit = b.ivr.randomDigit;
        if (b.ivr?.timeoutSec !== undefined) patch.ivrTimeoutSec = b.ivr.timeoutSec;
        if (b.protection?.attestationPolicy !== undefined)
          patch.attestationPolicy = b.protection.attestationPolicy;
        if (b.protection?.perMinute !== undefined)
          patch.callerLimitPerMinute = b.protection.perMinute;
        if (b.protection?.perHour !== undefined) patch.callerLimitPerHour = b.protection.perHour;
        const willIvr = patch.ivrEnabled ?? before.ivrEnabled;
        const willRandom = patch.ivrRandomDigit ?? before.ivrRandomDigit;
        const willDigit = patch.ivrDigit === undefined ? before.ivrDigit : patch.ivrDigit;
        if (willIvr && !willRandom && !willDigit) {
          throw new HttpError(
            422,
            'validation_error',
            'Choose the digit callers must press, or use a random digit',
            [{ path: 'ivr.digit', message: 'Required when the digit is not random' }],
          );
        }
        await tx.update(campaigns).set(patch).where(eq(campaigns.id, before.id));

        // Archiving takes the campaign's numbers out of service (they can be attached elsewhere).
        let freed: string[] = [];
        if (b.status === 'archived' && before.status !== 'archived') {
          const rows = await tx
            .update(phoneNumbers)
            .set({ campaignId: null })
            .where(and(eq(phoneNumbers.campaignId, before.id), eq(phoneNumbers.orgId, auth.orgId)))
            .returning({ e164: phoneNumbers.e164 });
          freed = rows.map((r) => r.e164);
        }
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: b.status === 'archived' ? 'campaign.archive' : 'campaign.update',
          entityType: 'campaign',
          entityId: before.id,
          before: {
            name: before.name,
            status: before.status,
            routingMode: before.routingMode,
            ringTimeoutSec: before.ringTimeoutSec,
          },
          after: b,
          ip: req.ip,
        });
        return freed;
      });
      await refresh(req.params.id);
      await app.routeCache.invalidate(...detached);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  // ── Numbers ──────────────────────────────────────────────────────────────

  app.post(
    '/campaigns/:id/numbers',
    {
      schema: { tags: ['campaigns'], params: campaignParams, body: attachNumberBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const e164 = await db.transaction(async (tx) => {
        const c = await lockCampaign(tx, auth.orgId, req.params.id);
        if (c.status === 'archived')
          throw new HttpError(
            409,
            'campaign_archived',
            'Restore the campaign before attaching numbers',
          );
        const [n] = await tx
          .select()
          .from(phoneNumbers)
          .where(and(eq(phoneNumbers.id, req.body.numberId), eq(phoneNumbers.orgId, auth.orgId)))
          .for('update')
          .limit(1);
        if (!n || n.status === 'released') throw notFound('Number');
        await tx.update(phoneNumbers).set({ campaignId: c.id }).where(eq(phoneNumbers.id, n.id));
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'campaign.attach_number',
          entityType: 'phone_number',
          entityId: n.id,
          before: { campaignId: n.campaignId },
          after: { campaignId: c.id, e164: n.e164 },
          ip: req.ip,
        });
        return n.e164;
      });
      await app.routeCache.invalidate(e164);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  app.delete(
    '/campaigns/:id/numbers/:numberId',
    {
      schema: { tags: ['campaigns'], params: numberParams },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const e164 = await db.transaction(async (tx) => {
        const c = await lockCampaign(tx, auth.orgId, req.params.id);
        const rows = await tx
          .update(phoneNumbers)
          .set({ campaignId: null })
          .where(
            and(
              eq(phoneNumbers.id, assertId(req.params.numberId, 'Number')),
              eq(phoneNumbers.orgId, auth.orgId),
              eq(phoneNumbers.campaignId, c.id),
            ),
          )
          .returning({ id: phoneNumbers.id, e164: phoneNumbers.e164 });
        if (!rows[0]) throw notFound('Number');
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'campaign.detach_number',
          entityType: 'phone_number',
          entityId: rows[0].id,
          before: { campaignId: c.id },
          after: { campaignId: null },
          ip: req.ip,
        });
        return rows[0].e164;
      });
      await app.routeCache.invalidate(e164);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  // ── Targets ──────────────────────────────────────────────────────────────

  app.post(
    '/campaigns/:id/targets',
    {
      schema: { tags: ['campaigns'], params: campaignParams, body: targetBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req, reply) => {
      const auth = authOf(req);
      await db.transaction(async (tx) => {
        const c = await lockCampaign(tx, auth.orgId, req.params.id);
        if (c.status === 'archived')
          throw new HttpError(
            409,
            'campaign_archived',
            'Restore the campaign before adding targets',
          );
        const [t] = await tx
          .insert(targets)
          .values({ orgId: auth.orgId, campaignId: c.id, targetType: 'phone', ...req.body })
          .returning({ id: targets.id });
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'target.create',
          entityType: 'target',
          entityId: t!.id,
          after: req.body,
          ip: req.ip,
        });
      });
      await refresh(req.params.id);
      return reply.status(201).send(ok<CampaignDto>(await detail(auth.orgId, req.params.id)));
    },
  );

  async function lockTarget(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orgId: string,
    campaignId: string,
    targetId: string,
  ) {
    const c = await lockCampaign(tx, orgId, campaignId);
    if (c.status === 'archived')
      throw new HttpError(409, 'campaign_archived', 'Restore the campaign before changing targets');
    const [t] = await tx
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.id, assertId(targetId, 'Target')),
          eq(targets.campaignId, c.id),
          eq(targets.orgId, orgId),
          isNull(targets.archivedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!t) throw notFound('Target');
    return t;
  }

  app.patch(
    '/campaigns/:id/targets/:targetId',
    {
      schema: { tags: ['campaigns'], params: targetParams, body: updateTargetBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      await db.transaction(async (tx) => {
        const before = await lockTarget(tx, auth.orgId, req.params.id, req.params.targetId);
        await tx
          .update(targets)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(targets.id, before.id));
        const { createdAt: _c, updatedAt: _u, ...beforeFields } = before;
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'target.update',
          entityType: 'target',
          entityId: before.id,
          before: beforeFields,
          after: req.body,
          ip: req.ip,
        });
      });
      await refresh(req.params.id);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  app.delete(
    '/campaigns/:id/targets/:targetId',
    {
      schema: { tags: ['campaigns'], params: targetParams },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      await db.transaction(async (tx) => {
        const t = await lockTarget(tx, auth.orgId, req.params.id, req.params.targetId);
        // Soft delete: past calls keep pointing at the target for reporting.
        await tx
          .update(targets)
          .set({ archivedAt: new Date(), enabled: false, updatedAt: new Date() })
          .where(eq(targets.id, t.id));
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'target.archive',
          entityType: 'target',
          entityId: t.id,
          before: { name: t.name, destination: t.destination },
          ip: req.ip,
        });
      });
      await refresh(req.params.id);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  app.put(
    '/campaigns/:id/targets/:targetId/schedule',
    {
      schema: { tags: ['campaigns'], params: targetParams, body: scheduleBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const problem = validateWindows(req.body.windows);
      if (problem)
        throw new HttpError(422, 'validation_error', problem, [
          { path: 'windows', message: problem },
        ]);
      await db.transaction(async (tx) => {
        const t = await lockTarget(tx, auth.orgId, req.params.id, req.params.targetId);
        await tx.delete(schedules).where(eq(schedules.targetId, t.id));
        const [s] = await tx
          .insert(schedules)
          .values({ targetId: t.id, timezone: req.body.timezone })
          .returning({ id: schedules.id });
        if (req.body.windows.length > 0) {
          await tx
            .insert(scheduleWindows)
            .values(
              req.body.windows.map((w) =>
                w.type === 'weekly'
                  ? {
                      scheduleId: s!.id,
                      dayOfWeek: w.dayOfWeek,
                      openTime: w.open,
                      closeTime: w.close,
                      kind: 'open' as const,
                    }
                  : {
                      scheduleId: s!.id,
                      dateStart: w.start,
                      dateEnd: w.end,
                      kind: w.kind,
                      openTime: w.open,
                      closeTime: w.close,
                    },
              ),
            );
        }
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'target.schedule',
          entityType: 'target',
          entityId: t.id,
          after: req.body,
          ip: req.ip,
        });
      });
      await refresh(req.params.id);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  app.delete(
    '/campaigns/:id/targets/:targetId/schedule',
    {
      schema: { tags: ['campaigns'], params: targetParams },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      await db.transaction(async (tx) => {
        const t = await lockTarget(tx, auth.orgId, req.params.id, req.params.targetId);
        await tx.delete(schedules).where(eq(schedules.targetId, t.id));
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'target.schedule',
          entityType: 'target',
          entityId: t.id,
          after: { schedule: 'always_open' },
          ip: req.ip,
        });
      });
      await refresh(req.params.id);
      return ok<CampaignDto>(await detail(auth.orgId, req.params.id));
    },
  );

  // ── Routing debug (owner/admin) ─────────────────────────────────────────

  app.post(
    '/campaigns/:id/explain',
    {
      schema: { tags: ['routing'], params: campaignParams, body: explainBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const at = req.body.at ? new Date(req.body.at) : new Date();
      return ok<ExplainDto>(
        await explainCampaign(
          sql,
          app.reserver,
          auth.orgId,
          assertId(req.params.id, 'Campaign'),
          at,
          new Set(req.body.triedTargetIds),
        ),
      );
    },
  );
};
