import type { Sql } from 'postgres';
import type { NumberDto, NumberStatus } from '@relay/core';
import { notFound } from '../lib/errors';

interface NumberRow {
  id: string;
  e164: string;
  country: string;
  number_type: 'toll_free' | 'local';
  provider: 'mock' | 'twilio' | 'telnyx';
  status: NumberStatus;
  created_at: Date;
  released_at: Date | null;
  ring_timeout_sec: number | null;
  destination: string | null;
  target_enabled: boolean | null;
  campaign_status: 'active' | 'paused' | 'archived' | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_numbers: number | null;
  campaign_targets: number | null;
}

export function toNumberDto(r: NumberRow): NumberDto {
  return {
    id: r.id,
    e164: r.e164,
    country: r.country,
    numberType: r.number_type,
    provider: r.provider,
    status: r.status,
    forwarding: {
      forwardTo: r.destination,
      ringTimeoutSec: r.ring_timeout_sec ?? 25,
      enabled:
        Boolean(r.destination) && r.target_enabled === true && r.campaign_status === 'active',
    },
    campaign:
      r.campaign_id && r.campaign_name && r.campaign_status
        ? {
            id: r.campaign_id,
            name: r.campaign_name,
            status: r.campaign_status,
            simple: (r.campaign_numbers ?? 0) <= 1 && (r.campaign_targets ?? 0) <= 1,
          }
        : null,
    createdAt: r.created_at.toISOString(),
    releasedAt: r.released_at ? r.released_at.toISOString() : null,
  };
}

/**
 * Numbers with their forwarding summary (campaign ring timeout + first phone target).
 * Always scoped by org. `includeReleased` keeps released numbers visible in history.
 */
export async function listNumbers(
  sql: Sql,
  orgId: string,
  opts: { id?: string; includeReleased?: boolean } = {},
): Promise<NumberDto[]> {
  const rows = await sql<NumberRow[]>`
    select pn.id, pn.e164, pn.country, pn.number_type, pn.provider, pn.status,
           pn.created_at, pn.released_at,
           c.ring_timeout_sec, c.status as campaign_status, c.id as campaign_id, c.name as campaign_name,
           (select count(*)::int from phone_numbers p2 where p2.campaign_id = c.id and p2.status <> 'released') as campaign_numbers,
           (select count(*)::int from targets t2 where t2.campaign_id = c.id and t2.archived_at is null) as campaign_targets,
           t.destination, t.enabled as target_enabled
    from phone_numbers pn
    left join campaigns c on c.id = pn.campaign_id and c.org_id = pn.org_id
    left join lateral (
      select destination, enabled from targets
      where campaign_id = c.id and org_id = pn.org_id and target_type = 'phone' and archived_at is null
      order by priority_tier, created_at, id
      limit 1
    ) t on true
    where pn.org_id = ${orgId}
      ${opts.id ? sql`and pn.id = ${opts.id}` : sql``}
      ${opts.includeReleased ? sql`` : sql`and pn.status <> 'released'`}
    order by pn.created_at desc, pn.id desc`;
  return rows.map(toNumberDto);
}

export async function getNumber(sql: Sql, orgId: string, id: string): Promise<NumberDto> {
  const [n] = await listNumbers(sql, orgId, { id, includeReleased: true });
  if (!n) throw notFound('Number');
  return n;
}
