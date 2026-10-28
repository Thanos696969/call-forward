import type { NumberStatus } from '@relay/core';
import { Badge } from '@relay/ui';
import { OUTCOME_LABEL, outcomeTone } from '@/lib/format';

const NUMBER_STATUS: Record<
  NumberStatus,
  { label: string; tone: 'green' | 'amber' | 'grey' | 'red' }
> = {
  active: { label: 'Active', tone: 'green' },
  provisioning: { label: 'Provisioning', tone: 'amber' },
  suspended: { label: 'Suspended', tone: 'red' },
  released: { label: 'Released', tone: 'grey' },
};

export function NumberStatusBadge({ status }: { status: NumberStatus }) {
  const s = NUMBER_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={outcomeTone(outcome)}>{OUTCOME_LABEL[outcome] ?? outcome}</Badge>;
}
