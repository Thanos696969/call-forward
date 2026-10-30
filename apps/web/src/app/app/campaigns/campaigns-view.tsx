'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { createCampaignBodySchema, type CampaignDto, type CampaignSummaryDto } from '@relay/core';
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  NativeSelect,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { qk, useCanManage, useMe } from '@/lib/queries';
import { EmptyState, PageHeader } from '@/components/app-shell';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';
import { CampaignStatusBadge, ROUTING_MODE_LABEL } from '@/components/routing-ui';

export function CampaignsView() {
  const router = useRouter();
  const me = useMe();
  const canManage = useCanManage();
  const tz = me.data?.org.timezone ?? 'UTC';
  const campaigns = useQuery({
    queryKey: qk.campaigns,
    queryFn: async () => (await api<CampaignSummaryDto[]>('/campaigns')).data,
  });
  const create = canManage ? <NewCampaignDialog /> : null;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="A campaign decides who answers: which phones ring, in what order, and how many calls each can take."
        actions={campaigns.data && campaigns.data.length > 0 ? create : null}
      />
      {campaigns.isPending ? (
        <Skeleton className="h-40" />
      ) : campaigns.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(campaigns.error)}
        </p>
      ) : campaigns.data.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          body="Create a campaign, add the phones that should answer, then attach your numbers to it."
          action={create}
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Status</TH>
                <TH>Ringing</TH>
                <TH className="text-right">Numbers</TH>
                <TH className="text-right">Targets</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {campaigns.data.map((c) => (
                <TR
                  key={c.id}
                  className="cursor-pointer hover:bg-muted/60"
                  onClick={() => router.push(`/app/campaigns/${c.id}`)}
                >
                  <TD className="font-medium">
                    <Link
                      href={`/app/campaigns/${c.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {c.name}
                    </Link>
                    {c.ivrEnabled ? (
                      <span className="ml-2 text-xs text-muted-foreground">Press-a-digit</span>
                    ) : null}
                  </TD>
                  <TD>
                    <CampaignStatusBadge status={c.status} />
                  </TD>
                  <TD>{ROUTING_MODE_LABEL[c.routingMode]}</TD>
                  <TD className="tnum text-right">{c.numbers}</TD>
                  <TD className="tnum text-right">
                    {c.enabledTargets}
                    {c.targets !== c.enabledTargets ? (
                      <span className="text-muted-foreground"> of {c.targets}</span>
                    ) : null}
                  </TD>
                  <TD className="text-muted-foreground">{formatDate(c.createdAt, tz)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}

function NewCampaignDialog() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: async (body: unknown) =>
      (await api<CampaignDto>('/campaigns', { method: 'POST', body })).data,
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: qk.campaigns });
      toast.success(`Created ${c.name}. Add the phones that should answer.`);
      setOpen(false);
      router.push(`/app/campaigns/${c.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) setErrors(err.fieldErrors());
      else toast.error(errorMessage(err));
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const parsed = createCampaignBodySchema.safeParse({
      name: fd.get('name'),
      routingMode: fd.get('routingMode'),
      ringTimeoutSec: Number(fd.get('ringTimeoutSec')),
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    create.mutate(parsed.data);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden /> New campaign
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>You can change all of this later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <Field id="name" label="Name" error={errors.name}>
            <Input placeholder="e.g. Sales line" autoFocus {...fieldProps('name', errors)} />
          </Field>
          <Field
            id="routingMode"
            label="How should phones ring?"
            hint="One at a time tries the next phone when nobody answers. Ring together calls every phone in a tier at once."
          >
            <NativeSelect id="routingMode" name="routingMode" defaultValue="sequential">
              <option value="sequential">{ROUTING_MODE_LABEL.sequential}</option>
              <option value="simultaneous">{ROUTING_MODE_LABEL.simultaneous}</option>
            </NativeSelect>
          </Field>
          <Field
            id="ringTimeoutSec"
            label="Ring each attempt for (seconds)"
            error={errors.ringTimeoutSec}
          >
            <Input
              type="number"
              min={5}
              max={120}
              defaultValue={25}
              className="w-32"
              {...fieldProps('ringTimeoutSec', errors)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create campaign'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
