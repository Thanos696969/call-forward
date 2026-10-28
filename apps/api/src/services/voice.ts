import type { Sql } from 'postgres';
import {
  isTerminalCallStatus,
  mapDialStatus,
  mapParentStatusWithoutDialResult,
  normalizeE164,
  parseDurationSeconds,
  selectTarget,
  type CompiledRoute,
} from '@relay/core';
import type { VoiceParams } from '@relay/core/server';

export const NOT_IN_SERVICE = 'This number is not in service.';
export const NOT_CONFIGURED = 'This number is not configured.';

/** Caller IDs can be "anonymous", "+266696687" (restricted) etc.; keep something readable. */
export function callerId(raw: string): string {
  return normalizeE164(raw) ?? (raw.trim().slice(0, 32) || 'unknown');
}

export type InboundPlan =
  | { kind: 'hangup'; message: string }
  | { kind: 'dial'; destination: string; ringTimeoutSec: number; callRowId: string };

/**
 * Decide what to do with an inbound call and record it. Idempotent on
 * (provider, CallSid): a retried webhook returns the same plan and never adds
 * a second call row or leg.
 */
export async function handleInbound(
  sql: Sql,
  provider: string,
  params: VoiceParams,
  route: CompiledRoute | null,
): Promise<InboundPlan> {
  if (!route) return { kind: 'hangup', message: NOT_IN_SERVICE };
  const decision = selectTarget(route);
  const from = callerId(params.from);

  if (decision.kind === 'reject') {
    await sql`
      insert into calls (org_id, campaign_id, number_id, provider, provider_call_id,
                         from_e164, to_e164, outcome, hangup_cause, ended_at, billed_seconds, metadata)
      values (${route.orgId}, ${route.campaign?.id ?? null}, ${route.numberId}, ${provider}, ${params.callSid},
              ${from}, ${route.e164}, 'rejected', ${decision.reason}, now(), 0,
              ${JSON.stringify({ outcomeSource: 'router', stirVerstat: params.stirVerstat ?? null })}::text::jsonb)
      on conflict (provider, provider_call_id) do nothing`;
    return {
      kind: 'hangup',
      message: decision.reason === 'org_inactive' ? NOT_IN_SERVICE : NOT_CONFIGURED,
    };
  }

  const { target, ringTimeoutSec } = decision;
  const [row] = await sql<{ id: string }[]>`
    with c as (
      insert into calls (org_id, campaign_id, number_id, target_id, provider, provider_call_id,
                         from_e164, to_e164, outcome, metadata)
      values (${route.orgId}, ${route.campaign?.id ?? null}, ${route.numberId}, ${target.id}, ${provider},
              ${params.callSid}, ${from}, ${route.e164}, 'in_progress',
              ${JSON.stringify({ stirVerstat: params.stirVerstat ?? null, destination: target.destination })}::text::jsonb)
      on conflict (provider, provider_call_id) do update set provider = excluded.provider
      returning id
    ), leg as (
      insert into call_legs (call_id, target_id, attempt)
      select id, ${target.id}, 1 from c
      on conflict (call_id, attempt) do nothing
    )
    select id from c`;
  if (!row) throw new Error('call upsert returned no row');
  return { kind: 'dial', destination: target.destination, ringTimeoutSec, callRowId: row.id };
}

/**
 * Apply the <Dial> result. The dial result is authoritative: it may overwrite
 * an outcome inferred earlier from a parent status callback, but a second dial
 * result for the same call is a no-op. Returns the call id and outcome when
 * something changed (so the caller enqueues finalisation exactly once).
 */
export async function handleDialResult(
  sql: Sql,
  provider: string,
  params: VoiceParams,
): Promise<{ callId: string; outcome: string } | null> {
  const outcome = mapDialStatus(params.dialCallStatus);
  const talk = outcome === 'completed' ? parseDurationSeconds(params.dialCallDuration) : 0;
  const answered = outcome === 'completed';
  const [row] = await sql<{ id: string; outcome: string }[]>`
    with u as (
      update calls set
        outcome = ${outcome},
        talk_seconds = ${talk},
        answered_at = case when ${answered}
          then coalesce(answered_at, greatest(started_at, now() - make_interval(secs => ${talk})))
          else answered_at end,
        ended_at = coalesce(ended_at, now()),
        ring_seconds = greatest(0, extract(epoch from (coalesce(ended_at, now()) - started_at))::int - ${talk}),
        hangup_cause = ${params.dialCallStatus ?? null},
        metadata = metadata || ${JSON.stringify({ outcomeSource: 'dial_result', dialCallSid: params.dialCallSid ?? null })}::text::jsonb
      where provider = ${provider} and provider_call_id = ${params.callSid}
        and (outcome = 'in_progress' or metadata->>'outcomeSource' = 'status')
      returning id, outcome, answered_at, ended_at
    ), leg as (
      update call_legs l set
        outcome = u.outcome,
        answered_at = u.answered_at,
        ended_at = u.ended_at
      from u where l.call_id = u.id and l.attempt = 1
    )
    select id, outcome from u`;
  return row ? { callId: row.id, outcome: row.outcome } : null;
}

const STATUS_RANK: Record<string, number> = {
  queued: 1,
  initiated: 1,
  ringing: 2,
  'in-progress': 3,
  completed: 4,
  busy: 4,
  failed: 4,
  'no-answer': 4,
  canceled: 4,
};

/**
 * Parent-call status callback. Only moves forward (ringing → in-progress → terminal)
 * and never overwrites an outcome set by the dial result.
 */
export async function handleStatus(
  sql: Sql,
  provider: string,
  params: VoiceParams,
): Promise<{ callId: string; outcome: string } | null> {
  const status = (params.callStatus ?? '').toLowerCase();
  const rank = STATUS_RANK[status];
  if (!rank) return null;
  const terminal = isTerminalCallStatus(status);
  const inferred = terminal ? mapParentStatusWithoutDialResult(status) : null;

  const [row] = await sql<{ id: string; outcome: string; changed: boolean }[]>`
    with prev as (
      select id, outcome from calls
      where provider = ${provider} and provider_call_id = ${params.callSid}
        and coalesce((metadata->>'statusRank')::int, 0) < ${rank}
      for update
    ), u as (
      update calls c set
        answered_at = case when ${status === 'in-progress'} then coalesce(c.answered_at, now()) else c.answered_at end,
        ended_at = case when ${terminal} then coalesce(c.ended_at, now()) else c.ended_at end,
        outcome = case when ${inferred !== null} and c.outcome = 'in_progress' then ${inferred ?? 'in_progress'} else c.outcome end,
        metadata = c.metadata
          || jsonb_build_object('statusRank', ${rank}::int, 'lastStatus', ${status}::text)
          || case when ${inferred !== null} and c.outcome = 'in_progress'
               then '{"outcomeSource":"status"}'::jsonb else '{}'::jsonb end
      from prev where c.id = prev.id
      returning c.id, c.outcome, (prev.outcome = 'in_progress' and c.outcome <> 'in_progress') as changed
    ), leg as (
      update call_legs l set outcome = u.outcome, ended_at = coalesce(l.ended_at, now())
      from u where l.call_id = u.id and l.attempt = 1 and l.outcome is null and u.changed
    )
    select id, outcome, changed from u`;
  return row?.changed ? { callId: row.id, outcome: row.outcome } : null;
}
