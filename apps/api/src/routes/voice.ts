import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseVoiceParams, type VoiceParams } from '@relay/core/server';
import type { VoiceResult } from '../services/voice';

const attemptQuery = z.object({ attempt: z.coerce.number().int().min(1).max(50) });
const legQuery = attemptQuery.extend({ target: z.uuid() });

/**
 * Carrier-facing voice webhooks: the latency-critical path. Not under /api/v1,
 * no session, exempt from CSRF; authenticated by the carrier signature over the
 * exact public URL (query string included).
 *
 *   /voice/inbound          new call → protection → IVR or first dial attempt
 *   /voice/ivr              press-a-digit answer → first dial attempt or hang up
 *   /voice/result?attempt=N <Dial> finished → done, or fail over to attempt N+1
 *   /voice/leg?attempt&target  per-destination ringing/answered/completed
 *   /voice/status           parent call ended
 */
export const voiceRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = app.deps;
  const { provider } = deps;

  function headerRecord(req: FastifyRequest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
      else if (Array.isArray(v) && v[0] !== undefined) out[k.toLowerCase()] = v[0];
    }
    return out;
  }

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

  async function respond(req: FastifyRequest, reply: FastifyReply, result: VoiceResult) {
    if (result.finished) await enqueue(req, result.finished);
    return xml(reply, result.twiml);
  }

  async function enqueue(req: FastifyRequest, c: { callId: string; outcome: string }) {
    try {
      await deps.jobs.enqueueFinalise(c.callId, c.outcome);
    } catch (err) {
      // The call row is already correct; finalisation can be re-driven. Never fail the carrier.
      req.log.error({ err, callId: c.callId }, 'failed to enqueue finalise-call');
    }
  }

  app.post('/voice/inbound', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    return respond(req, reply, await app.voice.inbound(params));
  });

  app.post('/voice/ivr', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    return respond(req, reply, await app.voice.ivr(params));
  });

  app.post('/voice/result', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    // Phase 1 numbers configured before attempts existed post without ?attempt; treat as attempt 1.
    const q = attemptQuery.safeParse(req.query);
    return respond(req, reply, await app.voice.dialResult(params, q.success ? q.data.attempt : 1));
  });

  app.post('/voice/leg', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    const q = legQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).type('text/plain').send('Bad leg query');
    await app.voice.legStatus(params, q.data.attempt, q.data.target);
    return reply.status(204).send();
  });

  app.post('/voice/status', { schema: { hide: true } }, async (req, reply) => {
    const params = authenticate(req, reply);
    if (!params) return reply;
    const finished = await app.voice.parentStatus(params);
    if (finished) await enqueue(req, finished);
    return reply.status(204).send();
  });
};
