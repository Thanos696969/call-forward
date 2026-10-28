import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, campaigns, eq, ne, phoneNumbers } from '@relay/db';
import {
  availableNumbersQuerySchema,
  isUsTollFree,
  maskE164,
  purchaseNumberBodySchema,
  type AvailableNumberDto,
  type NumberDto,
} from '@relay/core';
import { ProviderError } from '@relay/core/server';
import { writeAudit } from '../lib/audit';
import { HttpError, conflict, isUniqueViolation, notFound } from '../lib/errors';
import { ok } from '../lib/http';
import { READ_ROLES, WRITE_ROLES, authOf, requireRole } from '../plugins/auth';
import { getNumber, listNumbers } from '../services/numbers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const idParams = z.object({ id: z.string().max(64) });

/** Malformed ids are indistinguishable from ids that belong to someone else: 404. */
export function assertId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw notFound(what);
  return id;
}

export const numberRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;

  app.get(
    '/numbers',
    { schema: { tags: ['numbers'] }, preHandler: requireRole(deps, ...READ_ROLES) },
    async (req) => {
      const auth = authOf(req);
      return ok<NumberDto[]>(await listNumbers(deps.sql, auth.orgId));
    },
  );

  app.get(
    '/numbers/available',
    {
      schema: { tags: ['numbers'], querystring: availableNumbersQuerySchema },
      preHandler: requireRole(deps, ...READ_ROLES),
    },
    async (req) => {
      const q = req.query;
      let found;
      try {
        found = await deps.provider.searchNumbers({
          country: q.country,
          type: q.type,
          prefix: q.prefix,
          contains: q.contains,
          // Over-fetch so numbers already owned on Relay can be filtered out.
          limit: 100,
        });
      } catch (err) {
        req.log.error({ err }, 'number search failed');
        throw new HttpError(
          502,
          'provider_error',
          'The carrier could not search numbers right now. Try again.',
        );
      }
      // Hide numbers already active on Relay (relevant for the mock inventory and stale carrier caches).
      const owned = found.length
        ? await deps.sql<{ e164: string }[]>`
            select e164 from phone_numbers
            where status <> 'released' and e164 in ${deps.sql(found.map((n) => n.e164))}`
        : [];
      const taken = new Set(owned.map((r) => r.e164));
      const data: AvailableNumberDto[] = found
        .filter((n) => !taken.has(n.e164) && isUsTollFree(n.e164))
        .slice(0, q.limit)
        .map((n) => ({
          e164: n.e164,
          country: n.country,
          numberType: n.numberType,
          region: n.region,
        }));
      return ok(data);
    },
  );

  app.post(
    '/numbers',
    {
      schema: { tags: ['numbers'], body: purchaseNumberBodySchema },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req, reply) => {
      const auth = authOf(req);
      const { e164 } = req.body;
      if (!isUsTollFree(e164)) {
        throw new HttpError(
          422,
          'unsupported_number',
          'Only US toll-free numbers can be bought right now',
          [
            {
              path: 'e164',
              message: 'Choose a US toll-free number (800, 833, 844, 855, 866, 877 or 888)',
            },
          ],
        );
      }

      // Reserve the number first: the partial unique index stops two orgs buying it at once.
      let numberId: string;
      try {
        const [row] = await deps.db
          .insert(phoneNumbers)
          .values({
            orgId: auth.orgId,
            e164,
            country: 'US',
            numberType: 'toll_free',
            provider: deps.provider.id,
            status: 'provisioning',
          })
          .returning({ id: phoneNumbers.id });
        if (!row) throw new Error('insert failed');
        numberId = row.id;
      } catch (err) {
        if (isUniqueViolation(err, 'phone_numbers_active_e164')) {
          throw conflict('number_unavailable', 'That number is no longer available');
        }
        throw err;
      }

      let providerRef: string;
      try {
        ({ providerRef } = await deps.provider.purchaseNumber(e164));
      } catch (err) {
        req.log.error({ err, number: maskE164(e164) }, 'carrier purchase failed');
        await deps.db
          .update(phoneNumbers)
          .set({ status: 'released', releasedAt: new Date() })
          .where(eq(phoneNumbers.id, numberId));
        const status = err instanceof ProviderError && err.status && err.status < 500 ? 409 : 502;
        throw new HttpError(
          status,
          status === 409 ? 'number_unavailable' : 'provider_error',
          status === 409
            ? 'The carrier says that number is no longer available'
            : 'The carrier could not complete the purchase. You were not charged. Try again.',
        );
      }

      await deps.db.transaction(async (tx) => {
        const [campaign] = await tx
          .insert(campaigns)
          .values({ orgId: auth.orgId, name: `Forwarding — ${e164}` })
          .returning({ id: campaigns.id });
        if (!campaign) throw new Error('campaign insert failed');
        await tx
          .update(phoneNumbers)
          .set({ status: 'active', providerRef, campaignId: campaign.id })
          .where(and(eq(phoneNumbers.id, numberId), eq(phoneNumbers.orgId, auth.orgId)));
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'number.purchase',
          entityType: 'phone_number',
          entityId: numberId,
          after: { e164, provider: deps.provider.id },
          ip: req.ip,
        });
      });
      await app.routeCache.invalidate(e164);
      return reply.status(201).send(ok<NumberDto>(await getNumber(deps.sql, auth.orgId, numberId)));
    },
  );

  app.get(
    '/numbers/:id',
    {
      schema: { tags: ['numbers'], params: idParams },
      preHandler: requireRole(deps, ...READ_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      return ok<NumberDto>(
        await getNumber(deps.sql, auth.orgId, assertId(req.params.id, 'Number')),
      );
    },
  );

  app.delete(
    '/numbers/:id',
    {
      schema: { tags: ['numbers'], params: idParams },
      preHandler: requireRole(deps, ...WRITE_ROLES),
    },
    async (req) => {
      const auth = authOf(req);
      const id = assertId(req.params.id, 'Number');
      const released = await deps.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(phoneNumbers)
          .where(
            and(
              eq(phoneNumbers.id, id),
              eq(phoneNumbers.orgId, auth.orgId),
              ne(phoneNumbers.status, 'released'),
            ),
          )
          .for('update')
          .limit(1);
        if (!current) throw notFound('Number');
        await tx
          .update(phoneNumbers)
          .set({ status: 'released', releasedAt: new Date(), campaignId: null })
          .where(eq(phoneNumbers.id, id));
        if (current.campaignId) {
          await tx
            .update(campaigns)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(eq(campaigns.id, current.campaignId), eq(campaigns.orgId, auth.orgId)));
        }
        await writeAudit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'number.release',
          entityType: 'phone_number',
          entityId: id,
          before: { e164: current.e164, status: current.status },
          after: { status: 'released' },
          ip: req.ip,
        });
        return current;
      });
      await app.routeCache.invalidate(released.e164);
      // Best effort: the number is already out of service on our side.
      if (released.providerRef) {
        try {
          await deps.provider.releaseNumber(released.providerRef);
        } catch (err) {
          req.log.error(
            { err, number: maskE164(released.e164) },
            'carrier release failed; release it manually',
          );
        }
      }
      return ok<NumberDto>(await getNumber(deps.sql, auth.orgId, id));
    },
  );
};
