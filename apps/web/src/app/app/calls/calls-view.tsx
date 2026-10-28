'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CALL_OUTCOMES, type NumberDto } from '@relay/core';
import { Button, Card, Input, Label, NativeSelect } from '@relay/ui';
import { api } from '@/lib/api';
import { OUTCOME_LABEL, formatPhone, zonedMidnightIso } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { PageHeader } from '@/components/app-shell';
import { CallsTable } from '@/components/calls-table';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function CallsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const me = useMe();
  const tz = me.data?.org.timezone ?? 'UTC';
  const numbers = useQuery({
    queryKey: qk.numbers,
    queryFn: async () => (await api<NumberDto[]>('/numbers')).data,
  });

  const fromDate = params.get('from') ?? '';
  const toDate = params.get('to') ?? '';
  const outcome = params.get('outcome') ?? '';
  const numberId = params.get('numberId') ?? '';

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  }

  const filters = {
    from: DATE_RE.test(fromDate) ? zonedMidnightIso(fromDate, tz) : undefined,
    to: DATE_RE.test(toDate) ? zonedMidnightIso(toDate, tz, 1) : undefined,
    outcome: outcome || undefined,
    numberId: numberId || undefined,
  };
  const anyFilter = Boolean(fromDate || toDate || outcome || numberId);

  return (
    <>
      <PageHeader
        title="Call log"
        description="Every call to your numbers, newest first. Updates automatically."
      />
      <Card className="mb-4 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setParam('from', e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setParam('to', e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="outcome">Outcome</Label>
          <NativeSelect
            id="outcome"
            value={outcome}
            onChange={(e) => setParam('outcome', e.target.value)}
          >
            <option value="">All outcomes</option>
            {CALL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o] ?? o}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="numberId">Number</Label>
          <NativeSelect
            id="numberId"
            value={numberId}
            onChange={(e) => setParam('numberId', e.target.value)}
          >
            <option value="">All numbers</option>
            {(numbers.data ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {formatPhone(n.e164)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {anyFilter ? (
          <Button variant="ghost" onClick={() => router.replace(pathname, { scroll: false })}>
            Clear filters
          </Button>
        ) : null}
      </Card>
      <Card>
        <CallsTable filters={filters} timezone={tz} />
      </Card>
    </>
  );
}
