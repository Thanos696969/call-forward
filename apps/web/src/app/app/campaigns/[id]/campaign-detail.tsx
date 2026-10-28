'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@relay/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { useCanManage } from '@/lib/queries';
import { EmptyState } from '@/components/app-shell';
import { CampaignStatusBadge, ROUTING_MODE_LABEL } from '@/components/routing-ui';
import { ExplainTab } from './explain-tab';
import { IvrTab, NumbersTab, ProtectionTab, SettingsTab } from './settings-tabs';
import { TargetsTab } from './targets-tab';
import { useCampaign, useCampaignWrite } from './use-campaign';

export function CampaignDetail({ id }: { id: string }) {
  const canManage = useCanManage();
  const campaign = useCampaign(id);
  const write = useCampaignWrite(id);
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (campaign.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-80" />
      </div>
    );
  }
  if (campaign.isError) {
    const missing = campaign.error instanceof ApiError && campaign.error.status === 404;
    return (
      <EmptyState
        title={missing ? 'Campaign not found' : 'Could not load this campaign'}
        body={missing ? 'It may belong to another organisation.' : errorMessage(campaign.error)}
        action={
          <Button asChild variant="outline">
            <Link href="/app/campaigns">Back to campaigns</Link>
          </Button>
        }
      />
    );
  }

  const c = campaign.data;
  const archived = c.status === 'archived';
  const editable = canManage && !archived;

  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <div>
        <Link
          href="/app/campaigns"
          className="mb-3 inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden /> Campaigns
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
              <CampaignStatusBadge status={c.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {ROUTING_MODE_LABEL[c.routingMode]}, {c.ringTimeoutSec} s per attempt, {c.numbers}{' '}
              {c.numbers === 1 ? 'number' : 'numbers'}, {c.enabledTargets} of {c.targets} targets on
            </p>
          </div>
          {canManage ? (
            <div className="flex shrink-0 gap-2">
              {c.status === 'active' ? (
                <Button
                  variant="outline"
                  disabled={write.isPending}
                  onClick={() =>
                    write.mutate({
                      method: 'PATCH',
                      body: { status: 'paused' },
                      success: 'Paused. Callers hear that the number is not configured.',
                    })
                  }
                >
                  Pause
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={write.isPending}
                  onClick={() =>
                    write.mutate({
                      method: 'PATCH',
                      body: { status: 'active' },
                      success: 'Campaign is live',
                    })
                  }
                >
                  {archived ? 'Restore' : 'Resume'}
                </Button>
              )}
              {!archived ? (
                <Button
                  variant="outline"
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmArchive(true)}
                >
                  Archive
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {c.status !== 'active' ? (
          <p className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
            {archived
              ? 'This campaign is archived. Restore it to change settings or attach numbers.'
              : 'This campaign is paused. Calls to its numbers are not forwarded until you resume it.'}
          </p>
        ) : null}
      </div>

      <Tabs defaultValue="targets">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="targets">Targets</TabsTrigger>
            <TabsTrigger value="numbers">Numbers</TabsTrigger>
            <TabsTrigger value="settings">Ringing</TabsTrigger>
            <TabsTrigger value="ivr">Press-a-digit</TabsTrigger>
            <TabsTrigger value="protection">Protection</TabsTrigger>
            {canManage ? <TabsTrigger value="explain">Test routing</TabsTrigger> : null}
          </TabsList>
        </div>
        <TabsContent value="targets">
          <TargetsTab campaign={c} editable={editable} />
        </TabsContent>
        <TabsContent value="numbers">
          <NumbersTab campaign={c} editable={editable} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab campaign={c} editable={editable} />
        </TabsContent>
        <TabsContent value="ivr">
          <IvrTab campaign={c} editable={editable} />
        </TabsContent>
        <TabsContent value="protection">
          <ProtectionTab campaign={c} editable={editable} />
        </TabsContent>
        {canManage ? (
          <TabsContent value="explain">
            <ExplainTab campaign={c} />
          </TabsContent>
        ) : null}
      </Tabs>

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {c.name}?</DialogTitle>
            <DialogDescription>
              Its {c.numbers} {c.numbers === 1 ? 'number stops' : 'numbers stop'} forwarding until
              you attach them to another campaign. Call history is kept.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Keep campaign</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={write.isPending}
              onClick={() =>
                write.mutate({
                  method: 'PATCH',
                  body: { status: 'archived' },
                  success: 'Archived',
                  onDone: () => setConfirmArchive(false),
                })
              }
            >
              Archive campaign
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
