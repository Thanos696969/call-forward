import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { capWindowKeys } from '@relay/core';
import { createDb, type DbHandle } from '@relay/db';
import { DbReserver } from '../src';
import { seedCall, seedCampaign, target } from './fixtures';

let db: DbHandle;
beforeAll(() => {
  db = createDb(inject('databaseUrl'), { max: 20 });
});
afterAll(() => db.close());

describe('DbReserver (Redis-down fallback)', () => {
  it('serialises concurrent reservations and never exceeds the concurrency cap', async () => {
    const t = target({ ccCap: 3 });
    const { orgId, campaignId } = await seedCampaign(db.sql, [t]);
    const k = capWindowKeys('UTC', new Date());
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const { callId, callSid } = await seedCall(db.sql, orgId, campaignId);
        return db.sql.begin(async (tx) => {
          const res = await new DbReserver(tx).reserve({
            holder: `${callSid}:1`,
            candidates: [{ target: t, hourKey: k.hour, dayKey: k.day }],
            mode: 'sequential',
            now: new Date(),
            ttlSec: 85,
            random: 0.5,
          });
          // The reservation is the leg row, written in the same transaction.
          for (const id of res.picked) {
            await tx`insert into call_legs (call_id, target_id, attempt) values (${callId}, ${id}, 1)`;
          }
          return res;
        });
      }),
    );
    expect(outcomes.filter((o) => o.picked.length === 1)).toHaveLength(3);
    expect(outcomes.filter((o) => o.reasons[t.id] === 'cc_cap')).toHaveLength(9);
  });

  it('applies window caps from the leg history', async () => {
    const t = target({ hourlyCap: 1, ccCap: 10 });
    const { orgId, campaignId } = await seedCampaign(db.sql, [t]);
    const { callId } = await seedCall(db.sql, orgId, campaignId);
    await db.sql`insert into call_legs (call_id, target_id, attempt, ended_at) values (${callId}, ${t.id}, 1, now())`;
    const k = capWindowKeys('UTC', new Date());
    const res = await db.sql.begin((tx) =>
      new DbReserver(tx).reserve({
        holder: 'CAx:1',
        candidates: [{ target: t, hourKey: k.hour, dayKey: k.day }],
        mode: 'sequential',
        now: new Date(),
        ttlSec: 85,
        random: 0,
      }),
    );
    expect(res.picked).toEqual([]);
    expect(res.reasons[t.id]).toBe('hourly_cap');
    expect(res.usage[t.id]).toMatchObject({ concurrent: 0, hour: 1, day: 1, total: 1 });
  });
});
