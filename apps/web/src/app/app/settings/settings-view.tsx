'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  blocklistBodySchema,
  updateOrgBodySchema,
  type AuditLogDto,
  type BlocklistEntryDto,
  type MemberDto,
  type MeDto,
  type OrgDto,
} from '@relay/core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@relay/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatPhone } from '@/lib/format';
import { qk, useMe } from '@/lib/queries';
import { PageHeader } from '@/components/app-shell';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';

export function SettingsView() {
  const me = useMe();
  const canManage = me.data?.role === 'owner' || me.data?.role === 'admin';
  const tab = useSearchParams().get('tab') ?? 'organisation';
  return (
    <>
      <PageHeader
        title="Settings"
        description="Your organisation, the people in it, and a record of changes."
      />
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="organisation">Organisation</TabsTrigger>
          <TabsTrigger value="blocklist">Blocked callers</TabsTrigger>
          {canManage ? <TabsTrigger value="members">Members</TabsTrigger> : null}
          {canManage ? <TabsTrigger value="audit">Audit log</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="organisation">
          {me.data ? <OrgForm me={me.data} canManage={canManage} /> : <Skeleton className="h-64" />}
        </TabsContent>
        <TabsContent value="blocklist">
          <Blocklist timezone={me.data?.org.timezone ?? 'UTC'} canManage={canManage} />
        </TabsContent>
        {canManage ? (
          <TabsContent value="members">
            <Members timezone={me.data?.org.timezone ?? 'UTC'} />
          </TabsContent>
        ) : null}
        {canManage ? (
          <TabsContent value="audit">
            <AuditLog timezone={me.data?.org.timezone ?? 'UTC'} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

function OrgForm({ me, canManage }: { me: MeDto; canManage: boolean }) {
  const qc = useQueryClient();
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async (body: { name: string; timezone: string }) =>
      (await api<OrgDto>('/org', { method: 'PATCH', body })).data,
    onSuccess: (org) => {
      qc.setQueryData<MeDto>(qk.me, (prev) => (prev ? { ...prev, org } : prev));
      qc.invalidateQueries({ queryKey: qk.dashboard(7).slice(0, 1) });
      qc.invalidateQueries({ queryKey: qk.audit });
      toast.success('Organisation saved');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = { name: String(fd.get('name') ?? ''), timezone: String(fd.get('timezone') ?? '') };
    const parsed = updateOrgBodySchema.safeParse(body);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    save.mutate(body);
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Organisation</CardTitle>
        <CardDescription>
          {canManage
            ? 'Call times across Relay are shown in this time zone.'
            : 'Only owners and admins can change these.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <Field id="name" label="Name" error={errors.name}>
            <Input
              defaultValue={me.org.name}
              disabled={!canManage}
              {...fieldProps('name', errors)}
            />
          </Field>
          <Field id="timezone" label="Time zone" error={errors.timezone}>
            <NativeSelect
              defaultValue={me.org.timezone}
              disabled={!canManage}
              {...fieldProps('timezone', errors)}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {canManage ? (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

const ROLE_TONE = {
  owner: 'blue',
  admin: 'green',
  member: 'grey',
  buyer: 'grey',
  agent: 'grey',
} as const;

function Members({ timezone }: { timezone: string }) {
  const members = useQuery({
    queryKey: qk.members,
    queryFn: async () => (await api<MemberDto[]>('/org/members')).data,
  });
  if (members.isPending) return <Skeleton className="h-40" />;
  if (members.isError)
    return <p className="text-sm text-destructive">{errorMessage(members.error)}</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>Inviting teammates arrives with multi-user support.</CardDescription>
      </CardHeader>
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH>Email</TH>
            <TH>Role</TH>
            <TH>Joined</TH>
          </TR>
        </THead>
        <TBody>
          {members.data.map((m) => (
            <TR key={m.userId}>
              <TD>{m.name ?? '—'}</TD>
              <TD>{m.email}</TD>
              <TD>
                <Badge tone={ROLE_TONE[m.role]} dot={false} className="capitalize">
                  {m.role}
                </Badge>
              </TD>
              <TD>{formatDate(m.createdAt, timezone)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'auth.register': 'Created the organisation',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_reset': 'Reset password',
  'org.update': 'Updated organisation',
  'number.purchase': 'Bought a number',
  'number.release': 'Released a number',
  'forwarding.update': 'Changed forwarding',
  'call.finalised': 'Call finalised',
};

function describeChange(log: AuditLogDto): string {
  const after =
    log.after && typeof log.after === 'object' ? (log.after as Record<string, unknown>) : null;
  if (!after) return '';
  return Object.entries(after)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

function AuditLog({ timezone }: { timezone: string }) {
  const logs = useInfiniteQuery({
    queryKey: qk.audit,
    initialPageParam: '',
    queryFn: async ({ pageParam }) =>
      api<AuditLogDto[]>('/audit-logs', { query: { limit: 25, cursor: pageParam || undefined } }),
    getNextPageParam: (last) => last.meta?.nextCursor ?? undefined,
  });
  if (logs.isPending) return <Skeleton className="h-64" />;
  if (logs.isError) return <p className="text-sm text-destructive">{errorMessage(logs.error)}</p>;
  const rows = logs.data.pages.flatMap((p) => p.data);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Every sign-in and configuration change, newest first.</CardDescription>
      </CardHeader>
      <Table>
        <THead>
          <TR>
            <TH>When</TH>
            <TH>Who</TH>
            <TH>What</TH>
            <TH>Details</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((log) => (
            <TR key={log.id}>
              <TD className="tnum text-muted-foreground">
                {formatDateTime(log.createdAt, timezone)}
              </TD>
              <TD>{log.actorEmail ?? 'System'}</TD>
              <TD>{ACTION_LABEL[log.action] ?? log.action}</TD>
              <TD className="max-w-[24rem] truncate text-muted-foreground">
                {describeChange(log)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {logs.hasNextPage ? (
        <div className="p-4">
          <Button
            variant="outline"
            onClick={() => logs.fetchNextPage()}
            disabled={logs.isFetchingNextPage}
          >
            {logs.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Blocklist({ timezone, canManage }: { timezone: string; canManage: boolean }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const list = useQuery({
    queryKey: qk.blocklist,
    queryFn: async () => (await api<BlocklistEntryDto[]>('/blocklist')).data,
  });
  const add = useMutation({
    mutationFn: async (body: unknown) =>
      (await api<BlocklistEntryDto[]>('/blocklist', { method: 'POST', body })).data,
    onSuccess: (rows) => {
      qc.setQueryData(qk.blocklist, rows);
      toast.success('Blocked. Calls from this number are refused before anything rings.');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) setErrors(err.fieldErrors());
      toast.error(errorMessage(err));
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      (await api<BlocklistEntryDto[]>(`/blocklist/${id}`, { method: 'DELETE' })).data,
    onSuccess: (rows) => {
      qc.setQueryData(qk.blocklist, rows);
      toast.success('Unblocked');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const parsed = blocklistBodySchema.safeParse({
      e164: String(fd.get('e164') ?? '').replace(/[\s()-]/g, ''),
      reason: String(fd.get('reason') ?? '').trim() || null,
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    add.mutate(parsed.data, { onSuccess: () => form.reset() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Blocked callers</CardTitle>
        <CardDescription>
          Calls from these numbers are refused on every campaign and show as blocked in the call
          log.
        </CardDescription>
      </CardHeader>
      {canManage ? (
        <CardContent>
          <form
            onSubmit={onSubmit}
            noValidate
            className="grid gap-3 sm:grid-cols-[14rem_1fr_auto] sm:items-end"
          >
            <Field id="e164" label="Phone number" error={errors.e164}>
              <Input type="tel" placeholder="+13125550100" {...fieldProps('e164', errors)} />
            </Field>
            <Field id="reason" label="Reason (optional)" error={errors.reason}>
              <Input
                placeholder="e.g. Robocaller"
                maxLength={200}
                {...fieldProps('reason', errors)}
              />
            </Field>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Blocking…' : 'Block number'}
            </Button>
          </form>
        </CardContent>
      ) : null}
      {list.isPending ? (
        <Skeleton className="m-5 h-16" />
      ) : list.isError ? (
        <p className="p-5 text-sm text-destructive">{errorMessage(list.error)}</p>
      ) : list.data.length === 0 ? (
        <p className="p-5 pt-0 text-sm text-muted-foreground">No blocked numbers.</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Reason</TH>
              <TH>Added</TH>
              {canManage ? <TH className="sr-only">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {list.data.map((b) => (
              <TR key={b.id}>
                <TD className="tnum font-medium">{formatPhone(b.e164)}</TD>
                <TD className="text-muted-foreground">{b.reason ?? '–'}</TD>
                <TD className="text-muted-foreground">
                  {formatDate(b.createdAt, timezone)}
                  {b.createdBy ? `, ${b.createdBy}` : ''}
                </TD>
                {canManage ? (
                  <TD className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(b.id)}
                    >
                      Unblock
                    </Button>
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
