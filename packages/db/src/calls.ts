import { billedSecondsPlaceholder } from '@relay/core';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from './client';
import { auditLogs, calls } from './schema';

/**
 * finalise-call job (Phase 1): billed_seconds := talk_seconds, plus an audit row.
 * Idempotent: re-running for the same state changes nothing and writes no audit.
 * Phase 3 extends this with metering and the wallet ledger.
 */
export async function finaliseCall(
  db: Database,
  callId: string,
): Promise<'finalised' | 'unchanged' | 'not_ready'> {
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select({
        id: calls.id,
        orgId: calls.orgId,
        talkSeconds: calls.talkSeconds,
        billedSeconds: calls.billedSeconds,
        outcome: calls.outcome,
      })
      .from(calls)
      .where(eq(calls.id, callId))
      .for('update')
      .limit(1);
    if (!call || call.outcome === 'in_progress') return 'not_ready';
    const billed = billedSecondsPlaceholder(call.talkSeconds);
    const updated = await tx
      .update(calls)
      .set({ billedSeconds: billed })
      .where(
        and(
          eq(calls.id, callId),
          ne(calls.outcome, 'in_progress'),
          sql`${calls.billedSeconds} is distinct from ${billed}`,
        ),
      )
      .returning({ id: calls.id });
    if (updated.length === 0) return 'unchanged';
    await tx.insert(auditLogs).values({
      orgId: call.orgId,
      actorUserId: null,
      action: 'call.finalised',
      entityType: 'call',
      entityId: call.id,
      before: { billedSeconds: call.billedSeconds },
      after: { billedSeconds: billed, outcome: call.outcome },
    });
    return 'finalised';
  });
}
