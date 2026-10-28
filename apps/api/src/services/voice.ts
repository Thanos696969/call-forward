import type { Redis } from 'ioredis';
import type { Sql, TransactionSql } from 'postgres';
import {
  DEFAULT_UNAVAILABLE,
  IVR_NO_INPUT,
  IVR_WRONG_DIGIT,
  attestationAllows,
  isTerminalCallStatus,
  mapDialStatus,
  mapParentStatusWithoutDialResult,
  maskE164,
  normalizeE164,
  parseAttestation,
  parseDurationSeconds,
  planAttempt,
  randomIvrDigit,
  renderIvrPrompt,
  type CallOutcome,
  type CompiledRoute,
  type Reserver,
} from '@relay/core';
import type { TelephonyProvider, VoiceParams } from '@relay/core/server';
import {
  DbReserver,
  MAX_LEG_SEC,
  RedisReserver,
  callerLimitExceeded,
  holderOf,
  recordCallerAttempt,
  type RouteCache,
} from '@relay/routing';
import type { VoiceUrls } from '../config';

export const NOT_IN_SERVICE = 'This number is not in service.';
export const NOT_CONFIGURED = 'This number is not configured.';

/** Caller IDs can be "anonymous", "+266696687" (restricted) etc.; keep something readable. */
export function callerId(raw: string): string {
  return normalizeE164(raw) ?? (raw.trim().slice(0, 32) || 'unknown');
}

/**
 * The last instruction we gave the carrier for a call. Persisted with the call
 * so a retried webhook gets byte-for-byte the same answer without re-routing.
 */
type LastResponse =
  | { kind: 'dial'; attempt: number; ringTimeoutSec: number }
  | { kind: 'gather'; prompt: string; timeoutSec: number }
  | { kind: 'hangup'; message: string }
  | { kind: 'reject' }
  | { kind: 'empty' };

interface CallRow {
  id: string;
  org_id: string;
  campaign_id: string | null;
  provider_call_id: string;
  to_e164: string;
  outcome: CallOutcome;
  metadata: {
    lastResponse?: LastResponse;
    ivrDigit?: string;
    ivrResult?: 'passed' | 'wrong_digit' | 'no_input';
    outcomeSource?: string;
  } & Record<string, unknown>;
}

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface VoiceDeps {
  sql: Sql;
  redis: Redis;
  provider: TelephonyProvider;
  routeCache: RouteCache;
  urls: VoiceUrls;
  log: Logger;
  /** Injected so tests can make routing decisions deterministic. */
  random?: () => number;
  now?: () => Date;
}

export interface VoiceResult {
  twiml: string;
  /** Calls that reached a final outcome in this request (enqueue finalisation). */
  finished?: { callId: string; outcome: string };
}

const json = (v: unknown) => JSON.stringify(v);

/**
 * The routing engine's voice path. Every handler:
 *  - runs in one Postgres transaction holding the call row lock, so duplicate or
 *    concurrent carrier retries are serialised and see each other's effects;
 *  - is idempotent: a retry replays the stored `lastResponse` instead of re-routing;
 *  - reserves capacity in Redis atomically before dialling, falling back to a
 *    Postgres reservation if Redis is down.
 */
export class VoiceService {
  private readonly redisReserver: RedisReserver;
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(private readonly d: VoiceDeps) {
    this.redisReserver = new RedisReserver(d.redis);
    this.random = d.random ?? Math.random;
    this.now = d.now ?? (() => new Date());
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  async inbound(params: VoiceParams): Promise<VoiceResult> {
    const to = normalizeE164(params.to);
    const route = to ? await this.d.routeCache.get(to) : null;
    if (!route) return { twiml: this.d.provider.buildMessageAndHangup(NOT_IN_SERVICE) };
    const from = callerId(params.from);
    const now = this.now();
    const reservations: Array<{ targetId: string; holder: string }> = [];

    try {
      return await this.d.sql.begin(async (tx) => {
        const inserted = await tx<CallRow[]>`
          insert into calls (org_id, campaign_id, number_id, provider, provider_call_id, from_e164, to_e164, outcome, metadata)
          values (${route.orgId}, ${route.campaign?.id ?? null}, ${route.numberId}, ${this.d.provider.id},
                  ${params.callSid}, ${from}, ${route.e164}, 'in_progress',
                  ${json({ stirVerstat: params.stirVerstat ?? null })}::text::jsonb)
          on conflict (provider, provider_call_id) do nothing
          returning id, org_id, campaign_id, provider_call_id, to_e164, outcome, metadata`;
        const call = inserted[0];
        if (!call) {
          // A retry (or a concurrent duplicate): wait for the first request, then replay its answer.
          const existing = await this.lockCall(tx, params.callSid);
          return { twiml: await this.replay(tx, existing) };
        }

        const campaign = route.campaign;
        if (route.orgStatus !== 'active' || !campaign || campaign.status !== 'active') {
          const reason = route.orgStatus !== 'active' ? 'org_inactive' : 'not_configured';
          const message = reason === 'org_inactive' ? NOT_IN_SERVICE : NOT_CONFIGURED;
          return this.finish(tx, call, 'rejected', reason, { kind: 'hangup', message });
        }

        // Protection: blocklist, STIR/SHAKEN policy, per-caller rate limit.
        const verdict = await this.protect(tx, route, params, from, now);
        await this.event(tx, call, null, 'protection', verdict);
        if (verdict.blocked) {
          return this.finish(tx, call, 'blocked', String(verdict.reason), { kind: 'reject' });
        }

        if (campaign.ivr.enabled) {
          const digit = campaign.ivr.randomDigit
            ? randomIvrDigit(this.random())
            : (campaign.ivr.digit ?? '1');
          const prompt = renderIvrPrompt(campaign.ivr.prompt, digit);
          const last: LastResponse = {
            kind: 'gather',
            prompt,
            timeoutSec: campaign.ivr.timeoutSec,
          };
          await tx`update calls set metadata = metadata || ${json({ ivrDigit: digit, lastResponse: last })}::text::jsonb where id = ${call.id}`;
          await this.event(tx, call, null, 'ivr', {
            stage: 'prompted',
            digit,
            random: campaign.ivr.randomDigit,
          });
          return { twiml: this.render(last, []) };
        }

        return this.startAttempt(tx, call, route, 1, reservations);
      });
    } catch (err) {
      await this.compensate(reservations);
      throw err;
    }
  }

  // ── Press-a-digit ──────────────────────────────────────────────────────────

  async ivr(params: VoiceParams): Promise<VoiceResult> {
    const reservations: Array<{ targetId: string; holder: string }> = [];
    try {
      return await this.d.sql.begin(async (tx) => {
        const call = await this.lockCall(tx, params.callSid);
        if (!call) return { twiml: this.d.provider.buildEmptyResponse() };
        if (call.metadata.ivrResult || call.metadata.lastResponse?.kind !== 'gather') {
          return { twiml: await this.replay(tx, call) };
        }
        const pressed = (params.digits ?? '').trim();
        const expected = call.metadata.ivrDigit ?? '';
        const result =
          pressed === '' ? 'no_input' : pressed === expected ? 'passed' : 'wrong_digit';
        await tx`update calls set metadata = metadata || ${json({ ivrResult: result })}::text::jsonb where id = ${call.id}`;
        await this.event(tx, call, null, 'ivr', {
          stage: 'answered',
          result,
          pressed: pressed || null,
        });
        if (result !== 'passed') {
          return this.finish(tx, call, 'screened_out', `ivr_${result}`, {
            kind: 'hangup',
            message: result === 'no_input' ? IVR_NO_INPUT : IVR_WRONG_DIGIT,
          });
        }
        const route = await this.d.routeCache.get(call.to_e164);
        if (!route?.campaign || route.campaign.status !== 'active') {
          return this.finish(tx, call, 'rejected', 'not_configured', {
            kind: 'hangup',
            message: NOT_CONFIGURED,
          });
        }
        return this.startAttempt(tx, call, route, 1, reservations);
      });
    } catch (err) {
      await this.compensate(reservations);
      throw err;
    }
  }

  // ── Dial result: completion or failover ────────────────────────────────────

  async dialResult(params: VoiceParams, attempt: number): Promise<VoiceResult> {
    const ended: Array<{ targetId: string; holder: string }> = [];
    const fresh: Array<{ targetId: string; holder: string }> = [];
    let result: VoiceResult;
    try {
      result = await this.d.sql.begin(async (tx) => {
        const call = await this.lockCall(tx, params.callSid);
        if (!call) return { twiml: this.d.provider.buildEmptyResponse() };
        const [att] = await tx<{ id: string; dial_status: string | null; mode: string }[]>`
          select id, dial_status, mode from call_attempts where call_id = ${call.id} and attempt = ${attempt}`;
        if (!att || att.dial_status !== null) return { twiml: await this.replay(tx, call) };

        const outcome = mapDialStatus(params.dialCallStatus);
        const talk = outcome === 'completed' ? parseDurationSeconds(params.dialCallDuration) : 0;
        await tx`update call_attempts set dial_status = ${params.dialCallStatus ?? 'unknown'}, completed_at = now() where id = ${att.id}`;

        // Close this attempt's legs. The answered leg is the one the carrier names
        // (DialCallSid), or the one a leg callback marked answered, or the only leg.
        const legs = await tx<
          {
            id: string;
            target_id: string;
            provider_leg_id: string | null;
            answered_at: Date | null;
            ended_at: Date | null;
            released_at: Date | null;
          }[]
        >`
          select id, target_id, provider_leg_id, answered_at, ended_at, released_at
          from call_legs where call_id = ${call.id} and attempt = ${attempt} order by id`;
        let winner: (typeof legs)[number] | undefined;
        if (outcome === 'completed') {
          winner =
            legs.find((l) => params.dialCallSid && l.provider_leg_id === params.dialCallSid) ??
            legs.find((l) => l.answered_at !== null) ??
            legs[0];
        }
        for (const leg of legs) {
          const legOutcome =
            leg === winner ? 'completed' : outcome === 'completed' ? 'no_answer' : outcome;
          await tx`
            update call_legs set
              outcome = coalesce(outcome, ${legOutcome}),
              answered_at = case when ${leg === winner} then coalesce(answered_at, greatest(started_at, now() - make_interval(secs => ${talk}))) else answered_at end,
              talk_seconds = case when ${leg === winner} then ${talk}::int else talk_seconds end,
              ended_at = coalesce(ended_at, now()),
              released_at = coalesce(released_at, now())
            where id = ${leg.id}`;
          if (!leg.released_at)
            ended.push({
              targetId: leg.target_id,
              holder: holderOf(call.provider_call_id, attempt),
            });
        }
        // Slots are freed only after this transaction commits; a lost release is caught by the reaper.

        if (outcome === 'completed') {
          await tx`
            update calls set outcome = 'completed', talk_seconds = ${talk}, target_id = ${winner?.target_id ?? null},
              answered_at = coalesce(answered_at, greatest(started_at, now() - make_interval(secs => ${talk}))),
              ended_at = coalesce(ended_at, now()),
              ring_seconds = greatest(0, extract(epoch from (now() - started_at))::int - ${talk}),
              hangup_cause = ${params.dialCallStatus ?? null},
              metadata = metadata || ${json({ outcomeSource: 'dial_result', dialCallSid: params.dialCallSid ?? null, lastResponse: { kind: 'empty' } })}::text::jsonb
            where id = ${call.id}`;
          return {
            twiml: this.d.provider.buildEmptyResponse(),
            finished: { callId: call.id, outcome: 'completed' },
          };
        }
        if (outcome === 'abandoned' || call.outcome !== 'in_progress') {
          // The caller already hung up (or this is the carrier's report of it): nothing left to
          // ring. The dial result is the most specific account of what happened, so it wins.
          return this.finish(tx, call, outcome, params.dialCallStatus ?? 'canceled', {
            kind: 'empty',
          });
        }
        // no-answer / busy / failed: fail over to the next eligible target.
        const route = await this.d.routeCache.get(call.to_e164);
        if (!route?.campaign) {
          return this.finish(tx, call, outcome, 'not_configured', {
            kind: 'hangup',
            message: NOT_CONFIGURED,
          });
        }
        return this.startAttempt(tx, call, route, attempt + 1, fresh, outcome);
      });
    } catch (err) {
      await this.compensate(fresh);
      throw err;
    }
    // Free the slots of the attempt that just ended; the new attempt's reservations stay.
    await this.releaseEnded(ended);
    return result;
  }

  // ── Per-leg status (answered / completed) ──────────────────────────────────

  async legStatus(params: VoiceParams, attempt: number, targetId: string): Promise<void> {
    const parent = params.parentCallSid;
    if (!parent) return;
    const status = (params.callStatus ?? '').toLowerCase();
    const holder = holderOf(parent, attempt);
    const nowMs = this.now().getTime();
    if (status === 'in-progress' || status === 'answered') {
      await this.d.sql`
        update call_legs l set answered_at = coalesce(l.answered_at, now()), provider_leg_id = ${params.callSid}
        from calls c
        where l.call_id = c.id and c.provider = ${this.d.provider.id} and c.provider_call_id = ${parent}
          and l.attempt = ${attempt} and l.target_id = ${targetId} and l.ended_at is null`;
      await this.safe(
        () => this.redisReserver.extend(targetId, holder, nowMs + MAX_LEG_SEC * 1000),
        'extend',
      );
      return;
    }
    if (status === 'initiated' || status === 'ringing') {
      await this.d.sql`
        update call_legs l set provider_leg_id = coalesce(l.provider_leg_id, ${params.callSid})
        from calls c
        where l.call_id = c.id and c.provider = ${this.d.provider.id} and c.provider_call_id = ${parent}
          and l.attempt = ${attempt} and l.target_id = ${targetId}`;
      return;
    }
    if (!isTerminalCallStatus(status)) return;
    const legOutcome =
      status === 'completed'
        ? 'completed'
        : status === 'busy'
          ? 'busy'
          : status === 'failed'
            ? 'failed'
            : 'no_answer';
    const duration = parseDurationSeconds(params.callDuration);
    const updated = await this.d.sql<{ id: string }[]>`
      update call_legs l set
        outcome = coalesce(l.outcome, case when ${legOutcome} = 'completed' and l.answered_at is null then 'no_answer' else ${legOutcome} end),
        talk_seconds = case when l.answered_at is not null then ${duration}::int else l.talk_seconds end,
        provider_leg_id = coalesce(l.provider_leg_id, ${params.callSid}),
        ended_at = coalesce(l.ended_at, now()),
        released_at = coalesce(l.released_at, now())
      from calls c
      where l.call_id = c.id and c.provider = ${this.d.provider.id} and c.provider_call_id = ${parent}
        and l.attempt = ${attempt} and l.target_id = ${targetId}
      returning l.id`;
    if (updated.length > 0) await this.releaseEnded([{ targetId, holder }]);
  }

  // ── Parent call status ─────────────────────────────────────────────────────

  async parentStatus(params: VoiceParams): Promise<VoiceResult['finished'] | null> {
    const status = (params.callStatus ?? '').toLowerCase();
    if (!isTerminalCallStatus(status)) {
      if (status === 'in-progress') {
        await this.d.sql`
          update calls set metadata = metadata || jsonb_build_object('lastStatus', ${status}::text)
          where provider = ${this.d.provider.id} and provider_call_id = ${params.callSid}`;
      }
      return null;
    }
    const released: Array<{ targetId: string; holder: string }> = [];
    const finished = await this.d.sql.begin(async (tx) => {
      const call = await this.lockCall(tx, params.callSid);
      if (!call) return null;
      await tx`update calls set ended_at = coalesce(ended_at, now()),
          metadata = metadata || jsonb_build_object('lastStatus', ${status}::text, 'statusRank', 4) where id = ${call.id}`;
      // The caller left: close any leg still ringing and free its slot.
      const open = await tx<{ target_id: string; attempt: number }[]>`
          update call_legs set outcome = coalesce(outcome, 'abandoned'), ended_at = coalesce(ended_at, now()),
                               released_at = coalesce(released_at, now())
          where call_id = ${call.id} and ended_at is null
          returning target_id, attempt`;
      for (const l of open)
        released.push({
          targetId: l.target_id,
          holder: holderOf(call.provider_call_id, l.attempt),
        });
      if (call.outcome !== 'in_progress') return null;
      const inferred = mapParentStatusWithoutDialResult(status) ?? 'abandoned';
      await tx`update calls set outcome = ${inferred}, hangup_cause = coalesce(hangup_cause, ${status}),
          metadata = metadata || '{"outcomeSource":"status"}'::jsonb where id = ${call.id}`;
      return { callId: call.id, outcome: inferred };
    });
    await this.releaseEnded(released);
    return finished;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async protect(
    tx: TransactionSql,
    route: CompiledRoute,
    params: VoiceParams,
    from: string,
    now: Date,
  ) {
    const campaign = route.campaign!;
    const attestation = parseAttestation(params.stirVerstat);
    const [listed] = await tx<{ reason: string | null }[]>`
      select reason from blocklist_entries where org_id = ${route.orgId} and e164 = ${from} limit 1`;
    if (listed) return { blocked: true, reason: 'blocklist', attestation, note: listed.reason };
    if (!attestationAllows(campaign.protection.attestationPolicy, attestation)) {
      return {
        blocked: true,
        reason: 'attestation',
        attestation,
        policy: campaign.protection.attestationPolicy,
      };
    }
    const { perMinute, perHour } = campaign.protection;
    if (perMinute !== null || perHour !== null) {
      try {
        const counts = await recordCallerAttempt(
          this.d.redis,
          campaign.id,
          from,
          params.callSid,
          now,
        );
        const exceeded = callerLimitExceeded(counts, { perMinute, perHour });
        if (exceeded)
          return { blocked: true, reason: `rate_limit_${exceeded}`, attestation, counts };
        return { blocked: false, attestation, counts };
      } catch (err) {
        // Fail open: a Redis outage must not drop legitimate calls.
        this.d.log.warn({ err }, 'caller rate limit unavailable; allowing call');
      }
    }
    return { blocked: false, attestation };
  }

  /** Plan, reserve and record one dial attempt; or end the call when nothing is eligible. */
  private async startAttempt(
    tx: TransactionSql,
    call: CallRow,
    route: CompiledRoute,
    attempt: number,
    reservations: Array<{ targetId: string; holder: string }>,
    previousOutcome?: CallOutcome,
  ): Promise<VoiceResult> {
    const campaign = route.campaign!;
    const tried = new Set(
      (
        await tx<
          { target_id: string }[]
        >`select target_id from call_legs where call_id = ${call.id} and target_id is not null`
      ).map((r) => r.target_id),
    );
    const holder = holderOf(call.provider_call_id, attempt);
    const opts = { tried, now: this.now(), holder, random: this.random() };
    let reserver: Reserver = this.redisReserver;
    let plan;
    try {
      plan = await planAttempt(route, opts, reserver);
    } catch (err) {
      this.d.log.error(
        { err, callSid: call.provider_call_id },
        'redis reservation failed; using Postgres fallback',
      );
      reserver = new DbReserver(tx);
      await this.event(tx, call, attempt, 'fallback', { reason: 'redis_unavailable' });
      plan = await planAttempt(route, opts, reserver);
    }

    if (plan.kind === 'exhausted') {
      await this.event(tx, call, attempt, 'exhausted', {
        tiers: plan.explanation,
        reserver: reserver.name,
      });
      const configured = route.targets.some((t) => t.enabled && t.type === 'phone' && t.weight > 0);
      if (attempt === 1 && !configured) {
        return this.finish(tx, call, 'rejected', 'not_configured', {
          kind: 'hangup',
          message: NOT_CONFIGURED,
        });
      }
      const message = campaign.unavailableMessage?.trim() || DEFAULT_UNAVAILABLE;
      const outcome: CallOutcome = previousOutcome ?? 'rejected';
      return this.finish(
        tx,
        call,
        outcome,
        attempt === 1 ? 'no_eligible_target' : 'all_targets_tried',
        { kind: 'hangup', message },
      );
    }

    if (reserver === this.redisReserver) {
      for (const t of plan.targets) reservations.push({ targetId: t.id, holder });
    }
    await tx`
      insert into call_attempts (call_id, org_id, attempt, mode, tier, ring_timeout_sec)
      values (${call.id}, ${call.org_id}, ${attempt}, ${plan.mode}, ${plan.tier}, ${plan.ringTimeoutSec})
      on conflict (call_id, attempt) do nothing`;
    for (const t of plan.targets) {
      await tx`
        insert into call_legs (call_id, target_id, attempt, destination, tier)
        values (${call.id}, ${t.id}, ${attempt}, ${t.destination}, ${plan.tier})
        on conflict (call_id, attempt, target_id) do nothing`;
    }
    const last: LastResponse = { kind: 'dial', attempt, ringTimeoutSec: plan.ringTimeoutSec };
    await tx`
      update calls set target_id = ${plan.targets[0]?.id ?? null}, campaign_id = ${campaign.id},
        metadata = metadata || ${json({ destination: plan.targets[0]?.destination ?? null, lastResponse: last })}::text::jsonb
      where id = ${call.id}`;
    await this.event(tx, call, attempt, 'attempt', {
      tier: plan.tier,
      mode: plan.mode,
      picked: plan.targets.map((t) => t.id),
      tiers: plan.explanation,
      reserver: reserver.name,
    });
    this.d.log.info(
      {
        event: 'voice.dial',
        callSid: call.provider_call_id,
        attempt,
        tier: plan.tier,
        legs: plan.targets.length,
        to: maskE164(call.to_e164),
      },
      'dialling',
    );
    return {
      twiml: this.render(
        last,
        plan.targets.map((t) => ({ id: t.id, destination: t.destination })),
        call.to_e164,
      ),
    };
  }

  private async finish(
    tx: TransactionSql,
    call: CallRow,
    outcome: CallOutcome,
    cause: string,
    last: LastResponse,
  ): Promise<VoiceResult> {
    await tx`
      update calls set outcome = ${outcome}, hangup_cause = ${cause}, ended_at = coalesce(ended_at, now()),
        talk_seconds = coalesce(talk_seconds, 0),
        billed_seconds = case when ${outcome} in ('rejected', 'blocked', 'screened_out') then 0 else billed_seconds end,
        metadata = metadata || ${json({ outcomeSource: 'router', lastResponse: last })}::text::jsonb
      where id = ${call.id}`;
    return { twiml: this.render(last, []), finished: { callId: call.id, outcome } };
  }

  /** Rebuild the answer we already gave for this call (idempotent retries). */
  private async replay(tx: TransactionSql, call: CallRow | null): Promise<string> {
    const last = call?.metadata.lastResponse;
    if (!call || !last) return this.d.provider.buildEmptyResponse();
    if (last.kind !== 'dial') return this.render(last, []);
    const legs = await tx<{ target_id: string; destination: string }[]>`
      select target_id, destination from call_legs where call_id = ${call.id} and attempt = ${last.attempt} order by id`;
    return this.render(
      last,
      legs.map((l) => ({ id: l.target_id, destination: l.destination })),
      call.to_e164,
    );
  }

  private render(
    last: LastResponse,
    legs: Array<{ id: string; destination: string }>,
    callerIdE164?: string,
  ): string {
    const p = this.d.provider;
    switch (last.kind) {
      case 'dial':
        return p.buildDial({
          callerId: callerIdE164 ?? '',
          numbers: legs.map((l) => ({
            destination: l.destination,
            statusCallbackUrl: this.d.urls.legUrl(last.attempt, l.id),
          })),
          ringTimeoutSec: last.ringTimeoutSec,
          actionUrl: this.d.urls.attemptResultUrl(last.attempt),
        });
      case 'gather':
        return p.buildGather({
          prompt: last.prompt,
          actionUrl: this.d.urls.ivrUrl,
          timeoutSec: last.timeoutSec,
          noInputMessage: IVR_NO_INPUT,
        });
      case 'hangup':
        return p.buildMessageAndHangup(last.message);
      case 'reject':
        return p.buildReject();
      case 'empty':
        return p.buildEmptyResponse();
    }
  }

  private async lockCall(tx: TransactionSql, callSid: string): Promise<CallRow | null> {
    const [row] = await tx<CallRow[]>`
      select id, org_id, campaign_id, provider_call_id, to_e164, outcome, metadata from calls
      where provider = ${this.d.provider.id} and provider_call_id = ${callSid}
      for update`;
    return row ?? null;
  }

  private async event(
    tx: TransactionSql,
    call: CallRow,
    attempt: number | null,
    kind: string,
    detail: unknown,
  ) {
    await tx`insert into call_routing_events (call_id, org_id, attempt, kind, detail)
             values (${call.id}, ${call.org_id}, ${attempt}, ${kind}, ${json(detail)}::text::jsonb)`;
  }

  /** Undo Redis reservations when the transaction that would record them failed. */
  private async compensate(reservations: Array<{ targetId: string; holder: string }>) {
    await this.releaseEnded(reservations);
  }

  private async releaseEnded(list: Array<{ targetId: string; holder: string }>) {
    for (const r of list)
      await this.safe(() => this.redisReserver.release(r.targetId, r.holder), 'release');
  }

  private async safe(fn: () => Promise<unknown>, what: string) {
    try {
      await fn();
    } catch (err) {
      // The reaper/reconciler repairs Redis from Postgres within a minute.
      this.d.log.warn({ err }, `routing ${what} failed`);
    }
  }
}
