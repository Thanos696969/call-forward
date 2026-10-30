import {
  VERDICT_LABEL,
  type CampaignStatus,
  type ScheduleDto,
  type TargetVerdict,
} from '@relay/core';
import { Badge, cn } from '@relay/ui';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const DAY_NAMES_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: 'green' | 'amber' | 'grey' }> =
  {
    active: { label: 'Active', tone: 'green' },
    paused: { label: 'Paused', tone: 'amber' },
    archived: { label: 'Archived', tone: 'grey' },
  };

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const s = CAMPAIGN_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const VERDICT_TONE: Record<
  TargetVerdict | 'eligible',
  'green' | 'blue' | 'amber' | 'grey' | 'red'
> = {
  picked: 'green',
  eligible: 'green',
  not_picked: 'blue',
  cc_cap: 'amber',
  hourly_cap: 'amber',
  daily_cap: 'amber',
  total_cap: 'amber',
  outside_schedule: 'grey',
  already_tried: 'grey',
  disabled: 'grey',
  zero_weight: 'grey',
  unsupported_type: 'red',
};

export function VerdictBadge({ verdict }: { verdict: TargetVerdict | 'eligible' }) {
  const label = verdict === 'eligible' ? 'Eligible' : VERDICT_LABEL[verdict];
  return (
    <Badge tone={VERDICT_TONE[verdict]} dot={false}>
      {label}
    </Badge>
  );
}

/** A compact used-of-cap readout with a bar; no cap shows the count alone. */
export function UsageMeter({
  used,
  cap,
  label,
}: {
  used: number | null | undefined;
  cap: number | null;
  label: string;
}) {
  const value = used ?? 0;
  const ratio = cap ? Math.min(1, value / cap) : 0;
  const full = cap !== null && value >= cap;
  return (
    <div
      className="min-w-[4.5rem]"
      title={`${label}: ${value}${cap !== null ? ` of ${cap}` : ', no limit'}`}
    >
      <div className="tnum text-sm">
        <span className={cn(full && 'font-semibold text-warn')}>
          {used === null || used === undefined ? '–' : value}
        </span>
        <span className="text-muted-foreground"> / {cap ?? '∞'}</span>
      </div>
      {cap !== null ? (
        <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden>
          <div
            className={cn('h-1 rounded-full', full ? 'bg-warn' : 'bg-primary')}
            style={{ width: `${Math.max(ratio * 100, value > 0 ? 6 : 0)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function scheduleSummary(schedule: ScheduleDto | null): string {
  if (!schedule) return 'Always open';
  const weekly = schedule.windows.filter((w) => w.type === 'weekly');
  const dated = schedule.windows.filter((w) => w.type === 'date');
  const parts: string[] = [];
  if (weekly.length > 0) {
    const days = [...new Set(weekly.map((w) => (w.type === 'weekly' ? w.dayOfWeek : 0)))].sort();
    parts.push(days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(', '));
  } else {
    parts.push('Every day');
  }
  if (dated.length > 0)
    parts.push(`${dated.length} date ${dated.length === 1 ? 'override' : 'overrides'}`);
  return parts.join('; ');
}

export const ROUTING_MODE_LABEL = {
  sequential: 'One at a time',
  simultaneous: 'Ring together',
} as const;

export const ATTESTATION_LABEL = {
  allow_all: 'Allow every caller',
  block_failed: 'Block callers whose caller ID failed verification',
  require_a_or_b: 'Only allow verified caller IDs (A or B attestation)',
  require_a: 'Only allow fully verified caller IDs (A attestation)',
} as const;
