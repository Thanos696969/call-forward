import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { maskE164, normalizeE164 } from '@relay/core';
import { parseVoiceParams, type VoiceParams } from '@relay/core/server';
import { voiceUrls } from '../config';
import { handleDialResult, handleInbound, handleStatus } from '../services/voice';

/**
 * Carrier-facing voice webhooks. These are the latency-critical path:
 * signature check → cached route → one SQL round trip → TwiML.
 * They are not under /api/v1, carry no session, and are exempt from CSRF
 * (they are authenticated by the carrier signature instead).
 */
export const voiceRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const { provider } = deps;
  const urls = voiceUrls(deps.config);

  function headerRecord(req: FastifyRequest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v[0] !== undefined) out[k.toLowerCase()] = v[0];
    }
    return out;
  }

  /** Verify the signature against the public URL the carrier called, then parse. */
  function authenticate(req: FastifyRequest, reply: FastifyReply): VoiceParams | null {
    const raw = req.rawBody ?? '';
    const url = `${deps.config.publicApiUrl}${req.url}`;
    let valid = false;
    try {
      valid = provider.verifyWebhook(headerRecord(req), raw, url);
    } catch (err) {
      req.log.error({ err }, 'webhook verification error');
    }
    if (!valid) {
      req.log.warn({ path: req.url.split('?')[0] }, 'rejected webhook with invalid signature');
      void reply.status(403).type('text/plain').send('Forbidden');
      return null;
    }
    const params = parseVoiceParams(raw);
    if (!params) {
      void reply.status(400).type('text/plain').send('Missing CallSid');
      return null;
    }
    return params;
  }

  const xml = (reply: FastifyReply, body: string) =>
    reply.status(200).type(provider.responseContentType).send(body);

  app.post('/voice/inbound', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    const to = normalizeE164(params.to);
    const route = to ? await app.routeCache.get(to) : null;
    const plan = await handleInbound(deps.sql, provider.id, params, route);
    req.log.info(
      { event: 'voice.inbound', callSid: params.callSid, to: maskE164(to), plan: plan.kind },
      'inbound call',
    );
    if (plan.kind === 'hangup') return xml(reply, provider.buildMessageAndHangup(plan.message));
    return xml(
      reply,
      provider.buildInboundResponse({
        callId: plan.callRowId,
        to: to ?? params.to,
        from: params.from,
        destination: plan.destination,
        ringTimeoutSec: plan.ringTimeoutSec,
        resultUrl: urls.resultUrl,
      }),
    );
  });

  app.post('/voice/result', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    const changed = await handleDialResult(deps.sql, provider.id, params);
    if (changed) await enqueue(req, changed);
    req.log.info(
      {
        event: 'voice.result',
        callSid: params.callSid,
        dialStatus: params.dialCallStatus,
        applied: Boolean(changed),
      },
      'dial result',
    );
    return xml(reply, provider.buildEmptyResponse());
  });

  app.post('/voice/status', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    const changed = await handleStatus(deps.sql, provider.id, params);
    if (changed) await enqueue(req, changed);
    return reply.status(204).send();
  });

  async function enqueue(req: FastifyRequest, c: { callId: string; outcome: string }) {
    try {
      await deps.jobs.enqueueFinalise(c.callId, c.outcome);
    } catch (err) {
      // The call row is already correct; finalisation can be re-driven. Never fail the carrier.
      req.log.error({ err, callId: c.callId }, 'failed to enqueue finalise-call');
    }
  }
};
