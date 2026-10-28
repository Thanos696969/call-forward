'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft } from 'lucide-react';
import { normalizeE164, updateForwardingBodySchema, type NumberDto } from '@relay/core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Label,
  Skeleton,
  Switch,
} from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatPhone } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { EmptyState } from '@/components/app-shell';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';
import { RouteDiagram } from '@/components/route-diagram';
import { NumberStatusBadge } from '@/components/status';
import { CampaignStatusBadge } from '@/components/routing-ui';
import { CallsTable } from '@/components/calls-table';

export function NumberDetail({ id }: { id: string }) {
  const me = useMe();
  const canManage = me.data?.role === 'owner' || me.data?.role === 'admin';
  const tz = me.data?.org.timezone ?? 'UTC';
  const number = useQuery({
    queryKey: qk.number(id),
    queryFn: async () => (await api<NumberDto>(`/numbers/${id}`)).data,
  });

  if (number.isPending) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (number.isError) {
    const missing = number.error instanceof ApiError && number.error.status === 404;
    return (
      <EmptyState
        title={missing ? 'Number not found' : 'Could not load this number'}
        body={
          missing
            ? 'It may have been released, or it belongs to another organisation.'
            : errorMessage(number.error)
        }
        action={
          <Button asChild variant="outline">
            <Link href="/app/numbers">Back to numbers</Link>
          </Button>
        }
      />
    );
  }

  const n = number.data;
  const active = n.status === 'active';
  return (
    <div className="grid gap-6">
      <div>
        <Link
          href="/app/numbers"
          className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden /> Numbers
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="tnum text-3xl font-semibold tracking-tight">{formatPhone(n.e164)}</h1>
          <NumberStatusBadge status={n.status} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {n.numberType === 'toll_free' ? 'US toll-free' : 'US local'} number, bought{' '}
          {formatDate(n.createdAt, tz)}
          {n.releasedAt ? `, released ${formatDate(n.releasedAt, tz)}` : ''}
        </p>
      </div>

      <Card className="p-5 sm:p-6">
        <RouteDiagram
          number={n.e164}
          destination={n.forwarding.forwardTo}
          broken={!n.forwarding.enabled}
          live={n.forwarding.enabled}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr]">
        {active && n.campaign && !n.campaign.simple ? (
          <CampaignRoutingCard number={n} />
        ) : active ? (
          <ForwardingForm number={n} canManage={canManage} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Forwarding</CardTitle>
              <CardDescription>
                This number was released and no longer receives calls.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Recent calls to this number</CardTitle>
          </CardHeader>
          <CallsTable filters={{ numberId: n.id }} timezone={tz} compact />
        </Card>
      </div>

      {active && canManage ? <ReleaseNumber number={n} /> : null}
    </div>
  );
}

function ForwardingForm({ number, canManage }: { number: NumberDto; canManage: boolean }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(
    number.forwarding.forwardTo ? number.forwarding.enabled : true,
  );

  const save = useMutation({
    mutationFn: async (body: { forwardTo: string; ringTimeoutSec: number; enabled: boolean }) =>
      (await api<NumberDto>(`/numbers/${number.id}`, { method: 'PATCH', body })).data,
    onSuccess: (n) => {
      qc.setQueryData(qk.number(n.id), n);
      qc.invalidateQueries({ queryKey: qk.numbers, exact: true });
      toast.success(
        n.forwarding.enabled
          ? `Calls now ring ${formatPhone(n.forwarding.forwardTo ?? '')}`
          : 'Forwarding is off',
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const raw = String(fd.get('forwardTo') ?? '');
    const body = {
      forwardTo: normalizeE164(raw) ?? raw.trim(),
      ringTimeoutSec: Number(fd.get('ringTimeoutSec')),
      enabled,
    };
    const parsed = updateForwardingBodySchema.safeParse(body);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Forwarding</CardTitle>
        <CardDescription>
          {canManage
            ? 'Where calls to this number ring, and for how long.'
            : 'Only owners and admins can change forwarding.'}
          {number.campaign ? (
            <>
              {' '}
              For tiers, several phones, hours or limits, use{' '}
              <Link
                href={`/app/campaigns/${number.campaign.id}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                its campaign
              </Link>
              .
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <Field
            id="forwardTo"
            label="Destination phone"
            error={errors.forwardTo}
            hint="International format, e.g. +14155550123"
          >
            <Input
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              defaultValue={number.forwarding.forwardTo ?? ''}
              placeholder="+14155550123"
              disabled={!canManage}
              {...fieldProps('forwardTo', errors)}
            />
          </Field>
          <Field
            id="ringTimeoutSec"
            label="Ring for (seconds)"
            error={errors.ringTimeoutSec}
            hint="Between 5 and 120"
          >
            <Input
              type="number"
              min={5}
              max={120}
              step={1}
              defaultValue={number.forwarding.ringTimeoutSec}
              disabled={!canManage}
              className="w-32"
              {...fieldProps('ringTimeoutSec', errors)}
            />
          </Field>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="grid gap-0.5">
              <Label htmlFor="enabled">Forward calls</Label>
              <p className="text-xs text-muted-foreground">
                When off, callers hear that the number is not configured.
              </p>
            </div>
            <Switch
              id="enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canManage}
            />
          </div>
          {canManage ? (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save forwarding'}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** For numbers routed by a full campaign: the quick form would be misleading, so link to it. */
function CampaignRoutingCard({ number }: { number: NumberDto }) {
  const c = number.campaign!;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing</CardTitle>
        <CardDescription>
          Calls to this number are routed by a campaign with several phones or numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-3">
          <span className="font-medium">{c.name}</span>
          <CampaignStatusBadge status={c.status} />
        </div>
        <div>
          <Button asChild variant="outline">
            <Link href={`/app/campaigns/${c.id}`}>Open campaign</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ReleaseNumber({ number }: { number: NumberDto }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const release = useMutation({
    mutationFn: async () =>
      (await api<NumberDto>(`/numbers/${number.id}`, { method: 'DELETE' })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.numbers });
      toast.success(`Released ${formatPhone(number.e164)}`);
      setOpen(false);
      router.push('/app/numbers');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="font-semibold">Release this number</h2>
        <p className="text-sm text-muted-foreground">
          Calls stop immediately. Its call history stays in your log.
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            Release number
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Release {formatPhone(number.e164)}?</DialogTitle>
            <DialogDescription>
              Callers will stop reaching you on this number right away, and someone else may buy it.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Keep number</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => release.mutate()}
              disabled={release.isPending}
            >
              {release.isPending ? 'Releasing…' : 'Release number'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
