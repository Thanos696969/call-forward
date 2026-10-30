'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LiveCallDto } from '@relay/core';
import { Badge, Card, Skeleton, TBody, TD, TH, THead, TR, Table } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { qk } from '@/lib/queries';
import { EmptyState, PageHeader } from '@/components/app-shell';

const STATE: Record<
  LiveCallDto['state'],
  { label: string; tone: 'green' | 'amber' | 'blue' | 'grey' }
> = {
  connected: { label: 'Connected', tone: 'green' },
  ringing: { label: 'Ringing', tone: 'amber' },
  ivr: { label: 'Pressing a key', tone: 'blue' },
  routing: { label: 'Routing', tone: 'grey' },
};

function elapsed(fromIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Calls in progress, refreshed every 3 seconds; timers tick locally on the server's clock. */
export function LiveView() {
  const offset = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const live = useQuery({
    queryKey: qk.live,
    queryFn: async () => {
      const res = await api<LiveCallDto[]>('/calls/live');
      const server =
        typeof res.meta?.serverTime === 'string' ? Date.parse(res.meta.serverTime) : Date.now();
      offset.current = server - Date.now();
      return res.data;
    },
    refetchInterval: 3000,
  });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const clock = now + offset.current;

  return (
    <>
      <PageHeader
        title="Live calls"
        description="Calls happening right now. Updates every 3 seconds."
      />
      {live.isPending ? (
        <Skeleton className="h-40" />
      ) : live.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(live.error)}
        </p>
      ) : live.data.length === 0 ? (
        <EmptyState
          title="No calls in progress"
          body="When someone calls one of your numbers, you will see it here while it rings and while you talk."
        />
      ) : (
        <Card>
          <Table aria-live="polite">
            <THead>
              <TR>
                <TH>Caller</TH>
                <TH>Number dialled</TH>
                <TH>Campaign</TH>
                <TH>Status</TH>
                <TH>With</TH>
                <TH className="text-right">Duration</TH>
              </TR>
            </THead>
            <TBody>
              {live.data.map((c) => {
                const connected = c.legs.find((l) => l.state === 'connected');
                return (
                  <TR key={c.id}>
                    <TD className="tnum font-medium">
                      <Link
                        href={`/app/calls/${c.id}`}
                        className="rounded underline-offset-4 hover:underline"
                      >
                        {formatPhone(c.from)}
                      </Link>
                    </TD>
                    <TD className="tnum">{formatPhone(c.numberE164)}</TD>
                    <TD>
                      {c.campaign ? (
                        <Link
                          href={`/app/campaigns/${c.campaign.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {c.campaign.name}
                        </Link>
                      ) : (
                        '–'
                      )}
                    </TD>
                    <TD>
                      <Badge tone={STATE[c.state].tone}>{STATE[c.state].label}</Badge>
                      {c.attempt > 1 ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          attempt {c.attempt}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      {c.legs.length === 0
                        ? '–'
                        : (connected ? [connected] : c.legs).map((l) => (
                            <div key={`${l.targetId}-${l.attempt}`} className="text-sm">
                              {l.targetName ?? 'Target'}{' '}
                              <span className="tnum text-muted-foreground">
                                {l.destination ? formatPhone(l.destination) : ''}
                              </span>
                            </div>
                          ))}
                    </TD>
                    <TD className="tnum text-right">
                      {elapsed(c.startedAt, clock)}
                      {connected?.answeredAt ? (
                        <div className="text-xs text-muted-foreground">
                          talking {elapsed(connected.answeredAt, clock)}
                        </div>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
