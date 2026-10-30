'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_IVR_PROMPT,
  DEFAULT_UNAVAILABLE,
  type CampaignDto,
  type NumberDto,
} from '@relay/core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Textarea,
} from '@relay/ui';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { qk } from '@/lib/queries';
import { fieldProps } from '@/components/form-utils';
import { NumberStatusBadge } from '@/components/status';
import { ATTESTATION_LABEL, ROUTING_MODE_LABEL } from '@/components/routing-ui';
import { useCampaignWrite } from './use-campaign';

type Props = { campaign: CampaignDto; editable: boolean };

function SaveRow({
  pending,
  editable,
  label = 'Save changes',
}: {
  pending: boolean;
  editable: boolean;
  label?: string;
}) {
  if (!editable) return null;
  return (
    <div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : label}
      </Button>
    </div>
  );
}

const intOrNull = (v: FormDataEntryValue | null) =>
  v === null || String(v).trim() === '' ? null : Number(v);

export function SettingsTab({ campaign, editable }: Props) {
  const write = useCampaignWrite(campaign.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    write.mutate({
      method: 'PATCH',
      body: {
        name: String(fd.get('name') ?? ''),
        routingMode: String(fd.get('routingMode')),
        ringTimeoutSec: Number(fd.get('ringTimeoutSec')),
        unavailableMessage: String(fd.get('unavailableMessage') ?? '').trim() || null,
      },
      success: 'Saved',
      onFieldErrors: setErrors,
    });
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Ringing</CardTitle>
        <CardDescription>How each call is offered to your targets.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <Field id="name" label="Campaign name" error={errors.name}>
            <Input
              defaultValue={campaign.name}
              disabled={!editable}
              {...fieldProps('name', errors)}
            />
          </Field>
          <fieldset className="grid gap-2" disabled={!editable}>
            <legend className="mb-1 text-sm font-medium">Ring targets</legend>
            {(['sequential', 'simultaneous'] as const).map((mode) => (
              <label
                key={mode}
                className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <input
                  type="radio"
                  name="routingMode"
                  value={mode}
                  defaultChecked={campaign.routingMode === mode}
                  className="mt-1 accent-[hsl(var(--primary))]"
                />
                <span>
                  <span className="block text-sm font-medium">{ROUTING_MODE_LABEL[mode]}</span>
                  <span className="block text-sm text-muted-foreground">
                    {mode === 'sequential'
                      ? 'Pick one phone by weight. If it is busy or does not answer, try the next one.'
                      : 'Ring every available phone in the tier at the same time. The first to answer takes the call.'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field
            id="ringTimeoutSec"
            label="Ring each attempt for (seconds)"
            error={errors.ringTimeoutSec}
            hint="Between 5 and 120"
          >
            <Input
              type="number"
              min={5}
              max={120}
              defaultValue={campaign.ringTimeoutSec}
              className="w-32"
              disabled={!editable}
              {...fieldProps('ringTimeoutSec', errors)}
            />
          </Field>
          <Field
            id="unavailableMessage"
            label="When nobody can take the call, the caller hears"
            error={errors.unavailableMessage}
          >
            <Textarea
              defaultValue={campaign.unavailableMessage ?? ''}
              placeholder={DEFAULT_UNAVAILABLE}
              maxLength={300}
              disabled={!editable}
              {...fieldProps('unavailableMessage', errors)}
            />
          </Field>
          <SaveRow pending={write.isPending} editable={editable} />
        </form>
      </CardContent>
    </Card>
  );
}

export function IvrTab({ campaign, editable }: Props) {
  const write = useCampaignWrite(campaign.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(campaign.ivr.enabled);
  const [random, setRandom] = useState(campaign.ivr.randomDigit);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    write.mutate({
      method: 'PATCH',
      body: {
        ivr: {
          enabled,
          randomDigit: random,
          digit: random ? (campaign.ivr.digit ?? null) : String(fd.get('digit') ?? '1'),
          prompt: String(fd.get('prompt') ?? '').trim() || null,
          timeoutSec: Number(fd.get('timeoutSec')),
        },
      },
      success: enabled
        ? 'Callers now press a key before they are connected'
        : 'Press-a-digit is off',
      onFieldErrors: setErrors,
    });
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Press-a-digit</CardTitle>
        <CardDescription>
          Ask callers to press a key before anyone rings. Robocallers and wrong numbers drop off;
          they show as screened out in the call log.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="ivr-enabled">Ask callers to press a key</Label>
            <Switch
              id="ivr-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!editable}
            />
          </div>
          <Field
            id="prompt"
            label="What callers hear"
            error={errors['ivr.prompt']}
            hint="Write {digit} where the key should be spoken."
          >
            <Textarea
              name="prompt"
              id="prompt"
              defaultValue={campaign.ivr.prompt ?? ''}
              placeholder={DEFAULT_IVR_PROMPT}
              maxLength={300}
              disabled={!editable || !enabled}
            />
          </Field>
          <fieldset className="grid gap-2" disabled={!editable || !enabled}>
            <legend className="mb-1 text-sm font-medium">Key to press</legend>
            <label className="flex items-center gap-3">
              <input
                type="radio"
                name="digitMode"
                checked={!random}
                onChange={() => setRandom(false)}
                className="accent-[hsl(var(--primary))]"
              />
              <span className="text-sm">Always the same key</span>
              <NativeSelect
                name="digit"
                aria-label="Key"
                defaultValue={campaign.ivr.digit ?? '1'}
                className="w-20"
                disabled={random || !editable || !enabled}
              >
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex items-center gap-3">
              <input
                type="radio"
                name="digitMode"
                checked={random}
                onChange={() => setRandom(true)}
                className="accent-[hsl(var(--primary))]"
              />
              <span className="text-sm">A random key for each call (harder for bots to guess)</span>
            </label>
            {errors['ivr.digit'] ? (
              <p className="text-xs text-destructive">{errors['ivr.digit']}</p>
            ) : null}
          </fieldset>
          <Field id="timeoutSec" label="Wait for a key (seconds)" hint="Between 3 and 30">
            <Input
              name="timeoutSec"
              id="timeoutSec"
              type="number"
              min={3}
              max={30}
              defaultValue={campaign.ivr.timeoutSec}
              className="w-32"
              disabled={!editable || !enabled}
            />
          </Field>
          <SaveRow pending={write.isPending} editable={editable} />
        </form>
      </CardContent>
    </Card>
  );
}

export function ProtectionTab({ campaign, editable }: Props) {
  const write = useCampaignWrite(campaign.id);
  const [errors, setErrors] = useState<Record<string, string>>({});
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    write.mutate({
      method: 'PATCH',
      body: {
        protection: {
          attestationPolicy: String(fd.get('attestationPolicy')),
          perMinute: intOrNull(fd.get('perMinute')),
          perHour: intOrNull(fd.get('perHour')),
        },
      },
      success: 'Protection saved',
      onFieldErrors: setErrors,
    });
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Call protection</CardTitle>
        <CardDescription>
          Blocked calls are refused before anything rings and show as blocked in the call log.
          Blocked numbers apply to every campaign:{' '}
          <Link
            href="/app/settings?tab=blocklist"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            manage blocked callers
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="grid gap-5">
          <Field id="attestationPolicy" label="Caller ID verification (STIR/SHAKEN)">
            <NativeSelect
              id="attestationPolicy"
              name="attestationPolicy"
              defaultValue={campaign.protection.attestationPolicy}
              disabled={!editable}
            >
              {Object.entries(ATTESTATION_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={!editable}>
            <legend className="mb-2 text-sm font-medium">
              Limit repeat calls from the same number
            </legend>
            <Field id="perMinute" label="Per minute" error={errors['protection.perMinute']}>
              <Input
                type="number"
                min={1}
                defaultValue={campaign.protection.perMinute ?? ''}
                placeholder="No limit"
                {...fieldProps('perMinute', errors)}
              />
            </Field>
            <Field id="perHour" label="Per hour" error={errors['protection.perHour']}>
              <Input
                type="number"
                min={1}
                defaultValue={campaign.protection.perHour ?? ''}
                placeholder="No limit"
                {...fieldProps('perHour', errors)}
              />
            </Field>
          </fieldset>
          <SaveRow pending={write.isPending} editable={editable} />
        </form>
      </CardContent>
    </Card>
  );
}

export function NumbersTab({ campaign, editable }: Props) {
  const write = useCampaignWrite(campaign.id);
  const numbers = useQuery({
    queryKey: qk.numbers,
    queryFn: async () => (await api<NumberDto[]>('/numbers')).data,
  });
  const attachedIds = new Set(campaign.attachedNumbers.map((n) => n.id));
  const available = (numbers.data ?? []).filter(
    (n) => !attachedIds.has(n.id) && n.status === 'active',
  );
  const [pick, setPick] = useState('');

  return (
    <div className="grid max-w-3xl gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Numbers using this campaign</CardTitle>
          <CardDescription>Calls to these numbers are routed by this campaign.</CardDescription>
        </CardHeader>
        {campaign.attachedNumbers.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No numbers yet. Attach one below to start routing its calls here.
            </p>
          </CardContent>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Status</TH>
                {editable ? <TH className="sr-only">Actions</TH> : null}
              </TR>
            </THead>
            <TBody>
              {campaign.attachedNumbers.map((n) => (
                <TR key={n.id}>
                  <TD className="tnum font-medium">
                    <Link
                      href={`/app/numbers/${n.id}`}
                      className="rounded underline-offset-4 hover:underline"
                    >
                      {formatPhone(n.e164)}
                    </Link>
                  </TD>
                  <TD>
                    <NumberStatusBadge status={n.status} />
                  </TD>
                  {editable ? (
                    <TD className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={write.isPending}
                        onClick={() =>
                          write.mutate({
                            method: 'DELETE',
                            path: `/numbers/${n.id}`,
                            success: `${formatPhone(n.e164)} no longer forwards calls`,
                          })
                        }
                      >
                        Detach
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle>Attach a number</CardTitle>
            <CardDescription>
              A number belongs to one campaign at a time; attaching moves it here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every active number is already here.{' '}
                <Link
                  href="/app/numbers"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Buy another number
                </Link>
                .
              </p>
            ) : (
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pick)
                    write.mutate({
                      method: 'POST',
                      path: '/numbers',
                      body: { numberId: pick },
                      success: 'Number attached',
                      onDone: () => setPick(''),
                    });
                }}
              >
                <NativeSelect
                  aria-label="Number"
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                  className="sm:max-w-sm"
                >
                  <option value="">Choose a number</option>
                  {available.map((n) => (
                    <option key={n.id} value={n.id}>
                      {formatPhone(n.e164)}
                      {n.campaign ? ` (now: ${n.campaign.name})` : ' (not routed)'}
                    </option>
                  ))}
                </NativeSelect>
                <Button type="submit" disabled={!pick || write.isPending}>
                  Attach
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
