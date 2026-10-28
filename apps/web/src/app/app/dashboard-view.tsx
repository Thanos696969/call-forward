'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DashboardSummaryDto, NumberDto } from '@relay/core';
import { Button, Card, CardHeader, CardTitle, Skeleton, cn } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatPercent } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { EmptyState, PageHeader } from '@/components/app-shell';
import { CallsTable } from '@/components/calls-table';

const RANGES = [7, 30] as const;

export function DashboardView() {
  const me = useMe();
  const tz = me.data?.org.timezone ?? 'UTC';
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const summary = useQuery({
    queryKey: qk.dashboard(days),
    queryFn: async () =>
      (await api<DashboardSummaryDto>('/dashboard/summary', { query: { days } })).data,
    refetchInterval: 5000,
  });
  const numbers = useQuery({
    queryKey: qk.numbers,
    queryFn: async () => (await api<NumberDto[]>('/numbers')).data,
  });

  const rangePicker = (
    <div
      role="group"
      aria-label="Date range"
      className="inline-flex rounded-md border bg-surface p-0.5"
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={days === r}
          onClick={() => setDays(r)}
          className={cn(
            'rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            days === r
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {r} days
        </button>
      ))}
    </div>
  );

  if (numbers.data && numbers.data.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="Start by getting a number"
          body="Buy a toll-free number, point it at your phone, and your calls show up here as they happen."
          action={
            <Button asChild>
              <Link href="/app/numbers">Go to numbers</Link>
            </Button>
          }
        />
      </>
    );
  }

  const s = summary.data;
  const kpis: Array<{ label: string; value: string; hint: string }> = s
    ? [
        {
          label: 'Calls',
          value: s.calls.toLocaleString(),
          hint: `${s.missed} missed, ${s.failed} failed`,
        },
        {
          label: 'Answer rate',
          value: s.calls ? formatPercent(s.answerRate) : '—',
          hint: `${s.answered} answered`,
        },
        { label: 'Minutes', value: s.minutes.toLocaleString(), hint: 'Talk time, rounded up' },
        {
          label: 'Completed',
          value: s.completed.toLocaleString(),
          hint: 'Connected to your destination',
        },
      ]
    : [];

  return (
    <>
      <PageHeader title="Dashboard" description={`Last ${days} days`} actions={rangePicker} />

      {summary.isError ? (
        <p role="alert" className="mb-6 text-sm text-destructive">
          {errorMessage(summary.error)}
        </p>
      ) : null}

      <Card className="mb-6 grid grid-cols-2 lg:grid-cols-4">
        {s
          ? kpis.map((k, i) => (
              <div
                key={k.label}
                className={cn(
                  'p-5',
                  i % 2 === 1 && 'border-l',
                  i >= 2 && 'border-t lg:border-t-0',
                  i === 2 && 'lg:border-l',
                )}
              >
                <p className="text-sm text-muted-foreground">{k.label}</p>
                <p className="tnum mt-1 text-3xl font-semibold tracking-tight">{k.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{k.hint}</p>
              </div>
            ))
          : Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="p-5">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="mt-2 h-8 w-24" />
              </div>
            ))}
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Calls per day</CardTitle>
        </CardHeader>
        <div className="h-64 px-2 pb-4 sm:px-4">
          {s ? <DailyChart data={s.daily} /> : <Skeleton className="mx-3 h-full" />}
        </div>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Recent calls</CardTitle>
          <Button asChild variant="link" size="sm">
            <Link href="/app/calls">View call log</Link>
          </Button>
        </CardHeader>
        <CallsTable filters={{}} timezone={tz} pageSize={8} paginate={false} />
      </Card>
    </>
  );
}

function DailyChart({ data }: { data: DashboardSummaryDto['daily'] }) {
  const rows = data.map((d) => ({
    ...d,
    label: new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }),
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          minTickGap={16}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
          width={40}
        />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--surface))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 8,
            color: 'hsl(var(--foreground))',
          }}
          labelStyle={{ fontWeight: 600 }}
        />
        <Area
          type="monotone"
          dataKey="calls"
          name="Calls"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fill="url(#callsFill)"
        />
        <Area
          type="monotone"
          dataKey="answered"
          name="Answered"
          stroke="hsl(var(--signal))"
          strokeWidth={2}
          fill="transparent"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
