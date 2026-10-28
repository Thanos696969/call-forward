'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { CallDto } from '@relay/core';
import { Button, Skeleton, TBody, TD, TH, THead, TR, Table } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatPhone } from '@/lib/format';
import { qk } from '@/lib/queries';
import { OutcomeBadge } from './status';

export interface CallFilters {
  from?: string;
  to?: string;
  outcome?: string;
  numberId?: string;
}

/**
 * Cursor-paginated call log. `compact` hides the dialled-number column (used on a
 * number's own page). Polls every 3 s so new calls appear well inside 5 s.
 */
export function CallsTable({
  filters,
  timezone,
  compact = false,
  pageSize = compact ? 10 : 50,
  paginate = true,
}: {
  filters: CallFilters;
  timezone: string;
  compact?: boolean;
  pageSize?: number;
  paginate?: boolean;
}) {
  const router = useRouter();
  const key = Object.fromEntries(
    Object.entries({ ...filters, limit: String(pageSize) }).filter(([, v]) => v),
  ) as Record<string, string>;
  const calls = useInfiniteQuery({
    queryKey: qk.calls(key),
    initialPageParam: '',
    queryFn: async ({ pageParam }) =>
      api<CallDto[]>('/calls', { query: { ...key, cursor: pageParam || undefined } }),
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
    refetchInterval: 3000,
  });

  if (calls.isPending) {
    return (
      <div className="grid gap-2 p-5 pt-0">
        {Array.from({ length: compact ? 3 : 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (calls.isError) {
    return (
      <p role="alert" className="p-5 pt-0 text-sm text-destructive">
        {errorMessage(calls.error)}
      </p>
    );
  }
  const rows = calls.data.pages.flatMap((p) => p.data);
  if (rows.length === 0) {
    return (
      <p className="p-5 pt-0 text-sm text-muted-foreground">
        {Object.keys(filters).some((k) => filters[k as keyof CallFilters] && k !== 'numberId')
          ? 'No calls match these filters.'
          : 'No calls yet. Calls appear here a few seconds after they end.'}
      </p>
    );
  }

  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH>Started</TH>
            <TH>Caller</TH>
            {compact ? null : <TH>Number dialled</TH>}
            <TH>Rang</TH>
            <TH>Outcome</TH>
            <TH className="text-right">Talk time</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((c) => (
            <TR
              key={c.id}
              className="cursor-pointer hover:bg-muted/60"
              onClick={() => router.push(`/app/calls/${c.id}`)}
            >
              <TD className="tnum">
                <Link
                  href={`/app/calls/${c.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {formatDateTime(c.startedAt, timezone)}
                </Link>
              </TD>
              <TD className="tnum">{formatPhone(c.from)}</TD>
              {compact ? null : <TD className="tnum">{formatPhone(c.numberE164)}</TD>}
              <TD className="tnum text-muted-foreground">
                {c.destination ? formatPhone(c.destination) : '—'}
              </TD>
              <TD>
                <OutcomeBadge outcome={c.outcome} />
              </TD>
              <TD className="tnum text-right">
                {c.outcome === 'completed' ? formatDuration(c.talkSeconds) : '—'}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {paginate && calls.hasNextPage ? (
        <div className="p-4">
          <Button
            variant="outline"
            onClick={() => calls.fetchNextPage()}
            disabled={calls.isFetchingNextPage}
          >
            {calls.isFetchingNextPage ? 'Loading…' : 'Load older calls'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
