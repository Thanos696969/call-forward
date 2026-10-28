'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { NumberDto } from '@relay/core';
import { Card, Skeleton, TBody, TD, TH, THead, TR, Table } from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatPhone } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { EmptyState, PageHeader } from '@/components/app-shell';
import { NumberStatusBadge } from '@/components/status';
import { BuyNumberDialog } from './buy-number-dialog';

export function NumbersView() {
  const router = useRouter();
  const me = useMe();
  const canManage = me.data?.role === 'owner' || me.data?.role === 'admin';
  const tz = me.data?.org.timezone ?? 'UTC';
  const numbers = useQuery({
    queryKey: qk.numbers,
    queryFn: async () => (await api<NumberDto[]>('/numbers')).data,
  });

  const buy = canManage ? <BuyNumberDialog /> : null;

  return (
    <>
      <PageHeader
        title="Numbers"
        description="Each number forwards its calls to one destination phone."
        actions={numbers.data && numbers.data.length > 0 ? buy : null}
      />
      {numbers.isPending ? (
        <Card className="grid gap-3 p-5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </Card>
      ) : numbers.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(numbers.error)}
        </p>
      ) : numbers.data.length === 0 ? (
        <EmptyState
          title="You don't have a number yet"
          body={
            canManage
              ? 'Buy a toll-free number, point it at your phone, and calls start forwarding right away.'
              : 'An owner or admin of your organisation can buy one.'
          }
          action={buy}
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Type</TH>
                <TH>Status</TH>
                <TH>Forwards to</TH>
                <TH>Bought</TH>
              </TR>
            </THead>
            <TBody>
              {numbers.data.map((n) => (
                <TR
                  key={n.id}
                  className="cursor-pointer hover:bg-muted/60"
                  onClick={() => router.push(`/app/numbers/${n.id}`)}
                >
                  <TD className="tnum font-medium">
                    <Link
                      href={`/app/numbers/${n.id}`}
                      className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {formatPhone(n.e164)}
                    </Link>
                  </TD>
                  <TD>{n.numberType === 'toll_free' ? 'Toll-free' : 'Local'}</TD>
                  <TD>
                    <NumberStatusBadge status={n.status} />
                  </TD>
                  <TD className="tnum">
                    {n.forwarding.forwardTo ? (
                      <span
                        className={n.forwarding.enabled ? '' : 'text-muted-foreground line-through'}
                      >
                        {formatPhone(n.forwarding.forwardTo)}
                      </span>
                    ) : (
                      <span className="text-warn">Not set up</span>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">{formatDate(n.createdAt, tz)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
