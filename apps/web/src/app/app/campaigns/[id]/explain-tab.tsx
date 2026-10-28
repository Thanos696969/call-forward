'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CampaignDto, ExplainDto } from '@relay/core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@relay/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatPhone } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { VerdictBadge } from '@/components/routing-ui';

/** Admin dry run: what would happen if a call arrived at a given time. Nothing is reserved. */
export function ExplainTab({ campaign }: { campaign: CampaignDto }) {
  const me = useMe();
  const tz = me.data?.org.timezone ?? 'UTC';
  const [at, setAt] = useState('');
  const explain = useMutation({
    mutationFn: async () =>
      (
        await api<ExplainDto>(`/campaigns/${campaign.id}/explain`, {
          method: 'POST',
          body: at ? { at: new Date(at).toISOString() } : {},
        })
      ).data,
  });
  const result = explain.data;

  return (
    <div className="grid gap-5 [&>*]:min-w-0">
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Test routing</CardTitle>
          <CardDescription>
            See which targets a call would ring, and why the others would be skipped. Live limits
            use the current counters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              explain.mutate();
            }}
          >
            <Field
              id="explain-at"
              label="Call arriving at"
              hint="Leave empty for now. Uses your browser's time zone."
            >
              <Input
                id="explain-at"
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={explain.isPending}>
              {explain.isPending ? 'Checking…' : 'Run test'}
            </Button>
          </form>
          {explain.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {errorMessage(explain.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <div className="grid gap-4" aria-live="polite">
          <p className="text-sm">
            At {formatDateTime(result.at, tz)}:{' '}
            {result.campaignStatus !== 'active' ? (
              <strong>
                the campaign is {result.campaignStatus}, so callers would hear that the number is
                not configured.
              </strong>
            ) : result.wouldRingTier === null ? (
              <strong>
                no target could take the call; callers would hear the unavailable message.
              </strong>
            ) : (
              <strong>
                tier {result.wouldRingTier} would ring
                {result.mode === 'simultaneous' ? ', every eligible target at once' : ''}.
              </strong>
            )}
          </p>
          {result.tiers.map((tier) => (
            <Card key={tier.tier}>
              <CardHeader className="pb-1">
                <CardTitle>Tier {tier.tier}</CardTitle>
              </CardHeader>
              <Table>
                <THead>
                  <TR>
                    <TH>Target</TH>
                    <TH>Verdict</TH>
                    <TH>Live / hour / day / total</TH>
                    <TH className="text-right">Chance</TH>
                  </TR>
                </THead>
                <TBody>
                  {tier.targets.map((t) => (
                    <TR key={t.targetId}>
                      <TD>
                        <div className="font-medium">{t.name}</div>
                        <div className="tnum text-xs text-muted-foreground">
                          {formatPhone(t.destination)}
                        </div>
                      </TD>
                      <TD>
                        <VerdictBadge verdict={t.verdict} />
                      </TD>
                      <TD className="tnum text-muted-foreground">
                        {t.usage
                          ? `${t.usage.concurrent} / ${t.usage.hour} / ${t.usage.day} / ${t.usage.total}`
                          : 'Unavailable'}
                      </TD>
                      <TD className="tnum text-right">
                        {t.chance === null ? '–' : `${Math.round(t.chance * 100)}%`}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
