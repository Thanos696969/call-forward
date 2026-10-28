'use client';

import { useQuery } from '@tanstack/react-query';
import type { CallDetailDto, RoutingEventDto, TierExplanation } from '@relay/core';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  cn,
} from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { OUTCOME_LABEL, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { qk } from '@/lib/queries';
import { ATTESTATION_LABEL, ROUTING_MODE_LABEL, VerdictBadge } from '@/components/routing-ui';

const DIAL_STATUS: Record<string, string> = {
  completed: 'Answered',
  'no-answer': 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  canceled: 'Caller hung up',
};

/** Every dial attempt in order, with the phones it rang and what happened on each. */
export function AttemptsCard({ call, timezone }: { call: CallDetailDto; timezone: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attempts</CardTitle>
      </CardHeader>
      <CardContent>
        {call.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {call.outcome === 'rejected'
              ? 'Nothing was dialled: no target could take the call, or forwarding was off.'
              : call.outcome === 'blocked'
                ? 'Nothing was dialled: the caller was blocked by call protection.'
                : call.outcome === 'screened_out'
                  ? 'Nothing was dialled: the caller did not press the right key.'
                  : 'No attempts recorded.'}
          </p>
        ) : (
          <ol className="relative grid gap-6 border-l-2 pl-5">
            {call.attempts.map((a) => {
              const legs = call.legs.filter((l) => l.attempt === a.attempt);
              const answered = a.dialStatus === 'completed';
              return (
                <li key={a.attempt} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute -left-[27px] top-1 size-3 rounded-full ring-4 ring-surface',
                      answered ? 'bg-ok' : a.dialStatus ? 'bg-warn' : 'bg-primary',
                    )}
                  />
                  <p className="text-sm font-medium">
                    Attempt {a.attempt}: tier {a.tier}, {ROUTING_MODE_LABEL[a.mode].toLowerCase()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {a.dialStatus ? (DIAL_STATUS[a.dialStatus] ?? a.dialStatus) : 'Ringing'}
                    {', '}
                    <span className="tnum">{formatDateTime(a.createdAt, timezone)}</span>
                  </p>
                  <ul className="mt-2 grid gap-1">
                    {legs.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                        <span className="font-medium">{l.targetName ?? 'Target'}</span>
                        <span className="tnum text-muted-foreground">
                          {l.destination ? formatPhone(l.destination) : ''}
                        </span>
                        <span
                          className={cn(
                            l.outcome === 'completed' ? 'text-ok' : 'text-muted-foreground',
                          )}
                        >
                          {l.outcome
                            ? (OUTCOME_LABEL[l.outcome] ?? l.outcome)
                            : l.answeredAt
                              ? 'Talking'
                              : 'Ringing'}
                          {l.outcome === 'completed' && l.talkSeconds !== null
                            ? ` for ${formatDuration(l.talkSeconds)}`
                            : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function TierTable({ tiers, pickedTier }: { tiers: TierExplanation[]; pickedTier?: number }) {
  return (
    <div className="grid gap-3">
      {tiers.map((t) => (
        <div key={t.tier}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Tier {t.tier}
            {pickedTier === t.tier ? ' (dialled)' : ''}
          </p>
          <ul className="grid gap-1">
            {t.targets.map((x) => (
              <li key={x.targetId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="min-w-32 font-medium">{x.name}</span>
                <VerdictBadge verdict={x.verdict} />
                {x.usage ? (
                  <span className="tnum text-xs text-muted-foreground">
                    {x.usage.concurrent} live, {x.usage.hour} this hour, {x.usage.day} today,{' '}
                    {x.usage.total} total
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function describeProtection(d: Record<string, unknown>): string {
  const att = typeof d.attestation === 'string' ? d.attestation : 'none';
  const attText =
    att === 'none'
      ? 'no caller ID verification'
      : att === 'failed'
        ? 'caller ID verification failed'
        : `caller ID attestation ${att}`;
  if (!d.blocked) return `Allowed (${attText}).`;
  switch (d.reason) {
    case 'blocklist':
      return 'Blocked: the caller is on your blocked list.';
    case 'attestation':
      return `Blocked by the caller ID policy (${ATTESTATION_LABEL[(d.policy as keyof typeof ATTESTATION_LABEL) ?? 'allow_all'] ?? d.policy}); ${attText}.`;
    case 'rate_limit_per_minute':
      return 'Blocked: too many calls from this number in the last minute.';
    case 'rate_limit_per_hour':
      return 'Blocked: too many calls from this number in the last hour.';
    default:
      return `Blocked (${String(d.reason)}).`;
  }
}

/** Admin-only: the router's recorded reasoning for this call. */
export function RoutingExplanation({ callId, timezone }: { callId: string; timezone: string }) {
  const events = useQuery({
    queryKey: qk.callRouting(callId),
    queryFn: async () => (await api<RoutingEventDto[]>(`/calls/${callId}/routing`)).data,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Why it was routed this way</CardTitle>
        <CardDescription>
          Visible to owners and admins. Recorded at the moment of each decision.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.isPending ? (
          <Skeleton className="h-24" />
        ) : events.isError ? (
          <p className="text-sm text-destructive">{errorMessage(events.error)}</p>
        ) : events.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No routing decisions were recorded for this call.
          </p>
        ) : (
          <ol className="grid gap-5">
            {events.data.map((e) => {
              const d = e.detail;
              return (
                <li key={e.id} className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={e.kind === 'exhausted' || e.kind === 'fallback' ? 'amber' : 'blue'}
                      dot={false}
                    >
                      {e.kind === 'protection'
                        ? 'Call protection'
                        : e.kind === 'ivr'
                          ? 'Press-a-digit'
                          : e.kind === 'attempt'
                            ? `Attempt ${e.attempt}`
                            : e.kind === 'exhausted'
                              ? 'Nobody available'
                              : 'Redis fallback'}
                    </Badge>
                    <span className="tnum text-xs text-muted-foreground">
                      {formatDateTime(e.createdAt, timezone)}
                    </span>
                    {typeof d.reserver === 'string' && d.reserver !== 'redis' ? (
                      <span className="text-xs text-warn">reserved via {d.reserver}</span>
                    ) : null}
                  </div>
                  {e.kind === 'protection' ? (
                    <p className="text-sm">{describeProtection(d)}</p>
                  ) : null}
                  {e.kind === 'ivr' ? (
                    <p className="text-sm">
                      {d.stage === 'prompted'
                        ? `Asked the caller to press ${String(d.digit)}${d.random ? ' (random for this call)' : ''}.`
                        : d.result === 'passed'
                          ? 'The caller pressed the right key.'
                          : d.result === 'no_input'
                            ? 'The caller did not press anything.'
                            : `The caller pressed ${String(d.pressed)}.`}
                    </p>
                  ) : null}
                  {e.kind === 'fallback' ? (
                    <p className="text-sm">
                      Redis was unavailable, so capacity was checked in Postgres.
                    </p>
                  ) : null}
                  {(e.kind === 'attempt' || e.kind === 'exhausted') && Array.isArray(d.tiers) ? (
                    <TierTable
                      tiers={d.tiers as TierExplanation[]}
                      pickedTier={typeof d.tier === 'number' ? d.tier : undefined}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
