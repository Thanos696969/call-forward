import { auditLogs, type Database } from '@relay/db';

export interface AuditEntry {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

type Executor = Pick<Database, 'insert'>;

export async function writeAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
  });
}
