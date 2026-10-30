'use client';

import { useMemo, useState } from 'react';
import { Clock, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  scheduleBodySchema,
  targetBodySchema,
  type CampaignDto,
  type ScheduleWindow,
  type TargetDto,
} from '@relay/core';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  NativeSelect,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@relay/ui';
import { formatPhone } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { EmptyState } from '@/components/app-shell';
import { fieldProps, zodFieldErrors } from '@/components/form-utils';
import { DAY_NAMES_LONG, UsageMeter, scheduleSummary } from '@/components/routing-ui';
import { useCampaignWrite } from './use-campaign';

export function TargetsTab({ campaign, editable }: { campaign: CampaignDto; editable: boolean }) {
  const [editing, setEditing] = useState<TargetDto | 'new' | null>(null);
  const [scheduling, setScheduling] = useState<TargetDto | null>(null);
  const write = useCampaignWrite(campaign.id);

  const tiers = useMemo(() => {
    const map = new Map<number, TargetDto[]>();
    for (const t of campaign.targetList)
      map.set(t.priorityTier, [...(map.get(t.priorityTier) ?? []), t]);
    return [...map.entries()].sort(([a], [b]) => a - b);
  }, [campaign.targetList]);

  const addButton = editable ? (
    <Button onClick={() => setEditing('new')}>
      <Plus aria-hidden /> Add target
    </Button>
  ) : null;

  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Calls go to tier 1 first. Within a tier,{' '}
          {campaign.routingMode === 'sequential'
            ? 'one phone is picked by weight; if it does not answer, the next one is tried.'
            : 'every available phone rings at once and the first to answer takes the call.'}{' '}
          A lower tier is used only when nobody in the tiers above can take the call.
        </p>
        {campaign.targetList.length > 0 ? addButton : null}
      </div>

      {campaign.targetList.length === 0 ? (
        <EmptyState
          title="No targets yet"
          body="A target is a phone that answers calls for this campaign, like a sales desk, an agent's mobile or a call centre line."
          action={addButton}
        />
      ) : (
        tiers.map(([tier, targets]) => {
          const totalWeight = targets.filter((t) => t.enabled).reduce((a, t) => a + t.weight, 0);
          return (
            <Card key={tier}>
              <CardHeader className="pb-1">
                <CardTitle>Tier {tier}</CardTitle>
                <CardDescription>
                  {tier === tiers[0]?.[0]
                    ? 'Tried first.'
                    : `Used when tier ${tiers[tiers.findIndex(([n]) => n === tier) - 1]?.[0]} can't take the call.`}
                </CardDescription>
              </CardHeader>
              <Table>
                <THead>
                  <TR>
                    <TH>Target</TH>
                    <TH>Share</TH>
                    <TH>Live</TH>
                    <TH>This hour</TH>
                    <TH>Today</TH>
                    <TH>All time</TH>
                    <TH>Hours</TH>
                    <TH>On</TH>
                    {editable ? <TH className="sr-only">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {targets.map((t) => (
                    <TR key={t.id} className={t.enabled ? '' : 'text-muted-foreground'}>
                      <TD>
                        <div className="font-medium text-foreground">{t.name}</div>
                        <div className="tnum text-xs text-muted-foreground">
                          {formatPhone(t.destination)}
                        </div>
                      </TD>
                      <TD className="tnum">
                        {t.enabled && totalWeight > 0
                          ? `${Math.round((t.weight / totalWeight) * 100)}%`
                          : '–'}
                        <div className="text-xs text-muted-foreground">weight {t.weight}</div>
                      </TD>
                      <TD>
                        <UsageMeter
                          label="Calls in progress"
                          used={t.usage?.concurrent}
                          cap={t.ccCap}
                        />
                      </TD>
                      <TD>
                        <UsageMeter
                          label="Calls this hour"
                          used={t.usage?.hour}
                          cap={t.hourlyCap}
                        />
                      </TD>
                      <TD>
                        <UsageMeter label="Calls today" used={t.usage?.day} cap={t.dailyCap} />
                      </TD>
                      <TD>
                        <UsageMeter label="Calls in total" used={t.usage?.total} cap={t.totalCap} />
                      </TD>
                      <TD>
                        <div className="text-sm">{scheduleSummary(t.schedule)}</div>
                        {t.schedule ? (
                          <Badge tone={t.openNow ? 'green' : 'grey'} className="mt-1">
                            {t.openNow ? 'Open now' : 'Closed now'}
                          </Badge>
                        ) : null}
                      </TD>
                      <TD>
                        <Switch
                          checked={t.enabled}
                          disabled={!editable || write.isPending}
                          aria-label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.name}`}
                          onCheckedChange={(on) =>
                            write.mutate({
                              method: 'PATCH',
                              path: `/targets/${t.id}`,
                              body: { enabled: on },
                              success: on ? `${t.name} is taking calls` : `${t.name} is off`,
                            })
                          }
                        />
                      </TD>
                      {editable ? (
                        <TD>
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${t.name}`}
                              onClick={() => setEditing(t)}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Set hours for ${t.name}`}
                              onClick={() => setScheduling(t)}
                            >
                              <Clock />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${t.name}`}
                              onClick={() => {
                                if (window.confirm(`Remove ${t.name}? Its call history is kept.`)) {
                                  write.mutate({
                                    method: 'DELETE',
                                    path: `/targets/${t.id}`,
                                    success: `Removed ${t.name}`,
                                  });
                                }
                              }}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          );
        })
      )}

      {editing ? (
        <TargetDialog
          campaign={campaign}
          target={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {scheduling ? (
        <ScheduleDialog
          campaignId={campaign.id}
          target={scheduling}
          onClose={() => setScheduling(null)}
        />
      ) : null}
    </div>
  );
}

const capValue = (v: FormDataEntryValue | null) =>
  v === null || String(v).trim() === '' ? null : Number(v);

function TargetDialog({
  campaign,
  target,
  onClose,
}: {
  campaign: CampaignDto;
  target: TargetDto | null;
  onClose: () => void;
}) {
  const write = useCampaignWrite(campaign.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const nextTier = Math.max(1, ...campaign.targetList.map((t) => t.priorityTier));

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const parsed = targetBodySchema.safeParse({
      name: fd.get('name'),
      destination: String(fd.get('destination') ?? '').replace(/[\s()-]/g, ''),
      priorityTier: Number(fd.get('priorityTier')),
      weight: Number(fd.get('weight')),
      ccCap: Number(fd.get('ccCap')),
      hourlyCap: capValue(fd.get('hourlyCap')),
      dailyCap: capValue(fd.get('dailyCap')),
      totalCap: capValue(fd.get('totalCap')),
      enabled,
    });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    setErrors({});
    write.mutate({
      method: target ? 'PATCH' : 'POST',
      path: target ? `/targets/${target.id}` : '/targets',
      body: parsed.data,
      success: target ? `Saved ${parsed.data.name}` : `Added ${parsed.data.name}`,
      onFieldErrors: setErrors,
      onDone: onClose,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{target ? `Edit ${target.name}` : 'Add a target'}</DialogTitle>
          <DialogDescription>Leave a limit empty for no limit.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="name" label="Name" error={errors.name}>
              <Input
                defaultValue={target?.name ?? ''}
                placeholder="e.g. Sales desk"
                {...fieldProps('name', errors)}
              />
            </Field>
            <Field
              id="destination"
              label="Phone number"
              error={errors.destination}
              hint="International format, e.g. +14155550123"
            >
              <Input
                type="tel"
                defaultValue={target?.destination ?? ''}
                placeholder="+14155550123"
                {...fieldProps('destination', errors)}
              />
            </Field>
            <Field
              id="priorityTier"
              label="Tier"
              error={errors.priorityTier}
              hint="1 is tried first"
            >
              <Input
                type="number"
                min={1}
                max={10}
                defaultValue={target?.priorityTier ?? nextTier}
                {...fieldProps('priorityTier', errors)}
              />
            </Field>
            <Field
              id="weight"
              label="Weight"
              error={errors.weight}
              hint="Share of calls within the tier; 0 never picks it"
            >
              <Input
                type="number"
                min={0}
                max={1000}
                defaultValue={target?.weight ?? 100}
                {...fieldProps('weight', errors)}
              />
            </Field>
          </div>
          <fieldset className="grid gap-4 sm:grid-cols-4">
            <legend className="mb-2 text-sm font-medium">Limits</legend>
            <Field id="ccCap" label="At once" error={errors.ccCap}>
              <Input
                type="number"
                min={1}
                defaultValue={target?.ccCap ?? 10}
                {...fieldProps('ccCap', errors)}
              />
            </Field>
            <Field id="hourlyCap" label="Per hour" error={errors.hourlyCap}>
              <Input
                type="number"
                min={1}
                defaultValue={target?.hourlyCap ?? ''}
                placeholder="None"
                {...fieldProps('hourlyCap', errors)}
              />
            </Field>
            <Field id="dailyCap" label="Per day" error={errors.dailyCap}>
              <Input
                type="number"
                min={1}
                defaultValue={target?.dailyCap ?? ''}
                placeholder="None"
                {...fieldProps('dailyCap', errors)}
              />
            </Field>
            <Field id="totalCap" label="In total" error={errors.totalCap}>
              <Input
                type="number"
                min={1}
                defaultValue={target?.totalCap ?? ''}
                placeholder="None"
                {...fieldProps('totalCap', errors)}
              />
            </Field>
          </fieldset>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="target-enabled">Taking calls</Label>
            <Switch id="target-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div>
            <Button type="submit" disabled={write.isPending}>
              {write.isPending ? 'Saving…' : target ? 'Save target' : 'Add target'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type WeeklyRow = { type: 'weekly'; dayOfWeek: number; open: string; close: string };
type DatedRow = {
  type: 'date';
  start: string;
  end: string;
  kind: 'open' | 'closed';
  open: string | null;
  close: string | null;
};

function ScheduleDialog({
  campaignId,
  target,
  onClose,
}: {
  campaignId: string;
  target: TargetDto;
  onClose: () => void;
}) {
  const me = useMe();
  const write = useCampaignWrite(campaignId);
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const [timezone, setTimezone] = useState(
    target.schedule?.timezone ?? me.data?.org.timezone ?? 'America/New_York',
  );
  const [weekly, setWeekly] = useState<WeeklyRow[]>(
    (
      target.schedule?.windows.filter(
        (w): w is Extract<ScheduleWindow, { type: 'weekly' }> => w.type === 'weekly',
      ) ?? []
    ).map((w) => ({ ...w })),
  );
  const [dated, setDated] = useState<DatedRow[]>(
    (
      target.schedule?.windows.filter(
        (w): w is Extract<ScheduleWindow, { type: 'date' }> => w.type === 'date',
      ) ?? []
    ).map((w) => ({ ...w })),
  );
  const [error, setError] = useState<string | null>(null);

  function save() {
    const parsed = scheduleBodySchema.safeParse({
      timezone,
      windows: [
        ...weekly,
        ...dated.map((d) => ({ ...d, open: d.open || null, close: d.close || null })),
      ],
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check the hours');
    setError(null);
    write.mutate({
      method: 'PUT',
      path: `/targets/${target.id}/schedule`,
      body: parsed.data,
      success: `Saved hours for ${target.name}`,
      onDone: onClose,
    });
  }

  const weekdays = () =>
    setWeekly(
      [1, 2, 3, 4, 5].map((d) => ({ type: 'weekly', dayOfWeek: d, open: '09:00', close: '17:00' })),
    );
  const crossMidnight = weekly.some((w) => w.close <= w.open && w.close !== w.open);

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Hours for {target.name}</DialogTitle>
          <DialogDescription>
            Outside these hours the target is skipped. A closing time earlier than the opening time
            runs past midnight.
          </DialogDescription>
        </DialogHeader>

        <Field id="tz" label="Time zone">
          <NativeSelect id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <section aria-labelledby="weekly-h" className="grid gap-2">
          <div className="flex items-center justify-between">
            <h3 id="weekly-h" className="text-sm font-medium">
              Weekly hours
            </h3>
            <div className="flex gap-2">
              {weekly.length === 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={weekdays}>
                  Weekdays 9 to 5
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setWeekly([
                    ...weekly,
                    { type: 'weekly', dayOfWeek: 1, open: '09:00', close: '17:00' },
                  ])
                }
              >
                <Plus aria-hidden /> Add hours
              </Button>
            </div>
          </div>
          {weekly.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No weekly hours: open every day, except closed dates below.
            </p>
          ) : (
            weekly.map((w, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                <NativeSelect
                  aria-label="Day"
                  value={w.dayOfWeek}
                  onChange={(e) =>
                    setWeekly(
                      weekly.map((x, j) =>
                        j === i ? { ...x, dayOfWeek: Number(e.target.value) } : x,
                      ),
                    )
                  }
                >
                  {DAY_NAMES_LONG.map((d, n) => (
                    <option key={d} value={n}>
                      {d}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  aria-label="Opens"
                  type="time"
                  className="w-32"
                  value={w.open}
                  onChange={(e) =>
                    setWeekly(weekly.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))
                  }
                />
                <Input
                  aria-label="Closes"
                  type="time"
                  className="w-32"
                  value={w.close}
                  onChange={(e) =>
                    setWeekly(weekly.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove these hours"
                  onClick={() => setWeekly(weekly.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
          {crossMidnight ? (
            <p className="text-xs text-muted-foreground">
              Hours that close earlier than they open continue into the next morning.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="dated-h" className="grid gap-2">
          <div className="flex items-center justify-between">
            <h3 id="dated-h" className="text-sm font-medium">
              Dates
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const today = new Date().toISOString().slice(0, 10);
                setDated([
                  ...dated,
                  {
                    type: 'date',
                    start: today,
                    end: today,
                    kind: 'closed',
                    open: null,
                    close: null,
                  },
                ]);
              }}
            >
              <Plus aria-hidden /> Add dates
            </Button>
          </div>
          {dated.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Close for holidays, or set special hours for specific dates.
            </p>
          ) : (
            dated.map((d, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-[auto_auto_1fr_auto] sm:items-center"
              >
                <Input
                  aria-label="From"
                  type="date"
                  value={d.start}
                  onChange={(e) =>
                    setDated(dated.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
                  }
                />
                <Input
                  aria-label="To"
                  type="date"
                  value={d.end}
                  onChange={(e) =>
                    setDated(dated.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
                  }
                />
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    aria-label="Closed or special hours"
                    className="w-auto"
                    value={d.kind}
                    onChange={(e) =>
                      setDated(
                        dated.map((x, j) =>
                          j === i ? { ...x, kind: e.target.value as 'open' | 'closed' } : x,
                        ),
                      )
                    }
                  >
                    <option value="closed">Closed</option>
                    <option value="open">Open</option>
                  </NativeSelect>
                  {d.kind === 'open' ? (
                    <>
                      <Input
                        aria-label="Opens (empty for all day)"
                        type="time"
                        className="w-28"
                        value={d.open ?? ''}
                        onChange={(e) =>
                          setDated(
                            dated.map((x, j) =>
                              j === i ? { ...x, open: e.target.value || null } : x,
                            ),
                          )
                        }
                      />
                      <Input
                        aria-label="Closes (empty for all day)"
                        type="time"
                        className="w-28"
                        value={d.close ?? ''}
                        onChange={(e) =>
                          setDated(
                            dated.map((x, j) =>
                              j === i ? { ...x, close: e.target.value || null } : x,
                            ),
                          )
                        }
                      />
                    </>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove these dates"
                  onClick={() => setDated(dated.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </section>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2">
          {target.schedule ? (
            <Button
              type="button"
              variant="ghost"
              disabled={write.isPending}
              onClick={() =>
                write.mutate({
                  method: 'DELETE',
                  path: `/targets/${target.id}/schedule`,
                  success: `${target.name} is open at all times`,
                  onDone: onClose,
                })
              }
            >
              Remove hours (always open)
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={save} disabled={write.isPending}>
            {write.isPending ? 'Saving…' : 'Save hours'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
