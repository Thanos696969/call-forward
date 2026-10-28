'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import type { CallDetailDto } from '@relay/core';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, cn } from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { OUTCOME_LABEL, formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { EmptyState } from '@/components/app-shell';
import { RouteDiagram } from '@/components/route-diagram';
import { OutcomeBadge } from '@/components/status';

export function CallDetail({ id }: { id: string }) {
  const me = useMe();
  const tz = me.data?.org.timezone ?? 'UTC';
  const [showRaw, setShowRaw] = useState(false);
  const call = useQuery({
    queryKey: qk.call(id),
    queryFn: async () => (await api<CallDetailDto>(`/calls/${id}`)).data,
    refetchInterval: (q) => (q.state.data?.outcome === 'in_progress' ? 2000 : false),
  });

  if (call.isPending) return <Skeleton className="h-96" />;
  if (call.isError) {
    const missing = call.error instanceof ApiError && call.error.status === 404;
    return (
      <EmptyState
        title={missing ? 'Call not found' : 'Could not load this call'}
        body={missing ? 'It may belong to another organisation.' : errorMessage(call.error)}
        action={
          <Button asChild variant="outline">
            <Link href="/app/calls">Back to call log</Link>
          </Button>
        }
      />
    );
  }

  const c = call.data;
  const facts: Array<[string, React.ReactNode]> = [
    ['Started', formatDateTime(c.startedAt, tz)],
    ['Answered', formatDateTime(c.answeredAt, tz)],
    ['Ended', formatDateTime(c.endedAt, tz)],
    ['Ringing', formatDuration(c.ringSeconds)],
    ['Talk time', formatDuration(c.talkSeconds)],
    ['Billed', formatDuration(c.billedSeconds)],
    ['Carrier', c.provider],
    [
      'Carrier call ID',
      <span key="sid" className="break-all">
        {c.providerCallId}
      </span>,
    ],
  ];

  return (
    <div className="grid gap-6">
      <div>
        <Link
          href="/app/calls"
          className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden /> Call log
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tnum text-2xl font-semibold tracking-tight">
            Call from {formatPhone(c.from)}
          </h1>
          <OutcomeBadge outcome={c.outcome} />
        </div>
      </div>

      <Card className="p-5 sm:p-6">
        <RouteDiagram
          from={c.from}
          number={c.numberE164}
          destination={c.destination}
          broken={c.outcome === 'rejected'}
          live={c.outcome === 'in_progress'}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              {facts.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="tnum min-w-0">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attempts</CardTitle>
          </CardHeader>
          <CardContent>
            {c.legs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {c.outcome === 'rejected'
                  ? 'Nothing was dialled: forwarding was not set up or was switched off.'
                  : 'No attempts recorded.'}
              </p>
            ) : (
              <ol className="relative grid gap-5 border-l-2 pl-5">
                {c.legs.map((leg) => (
                  <li key={leg.id} className="relative">
                    <span
                      aria-hidden
                      className={cn(
                        'absolute -left-[27px] top-1 size-3 rounded-full ring-4 ring-surface',
                        leg.outcome === 'completed'
                          ? 'bg-ok'
                          : leg.outcome
                            ? 'bg-warn'
                            : 'bg-primary',
                      )}
                    />
                    <p className="text-sm font-medium">
                      Attempt {leg.attempt}: rang{' '}
                      {leg.destination ? formatPhone(leg.destination) : 'destination'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {OUTCOME_LABEL[leg.outcome ?? 'in_progress'] ?? leg.outcome}
                      {leg.sipCode ? `, SIP ${leg.sipCode}` : ''}
                    </p>
                    <p className="tnum mt-1 text-xs text-muted-foreground">
                      {formatDateTime(leg.startedAt, tz)}
                      {leg.endedAt ? ` until ${formatDateTime(leg.endedAt, tz)}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="rounded-lg border">
        <button
          type="button"
          aria-expanded={showRaw}
          aria-controls="raw-metadata"
          onClick={() => setShowRaw((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg p-4 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Raw call data
          <ChevronDown
            className={cn('size-4 transition-transform', showRaw && 'rotate-180')}
            aria-hidden
          />
        </button>
        {showRaw ? (
          <pre id="raw-metadata" className="overflow-x-auto border-t p-4 text-xs">
            {JSON.stringify({ hangupCause: c.hangupCause, ...c.metadata }, null, 2)}
          </pre>
        ) : null}
      </section>
    </div>
  );
}
