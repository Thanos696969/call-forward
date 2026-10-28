import { eq } from 'drizzle-orm';
import type { Database } from './client';
import { hashPassword } from './password';
import { campaigns, memberships, organizations, phoneNumbers, targets, users } from './schema';

export const DEMO = {
  orgName: 'Demo Co',
  orgSlug: 'demo-co',
  email: 'demo@relay.local',
  password: 'relay-demo-password',
  number: '+18005550100',
  destination: '+14155550123',
} as const;

/**
 * Idempotent demo data: one organisation, one owner, one active mock toll-free
 * number forwarding to a placeholder destination. Development only.
 */
export async function seedDemo(db: Database): Promise<{ created: boolean }> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO.email));
  if (existing.length > 0) return { created: false };

  const passwordHash = await hashPassword(DEMO.password);
  await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: DEMO.orgName, slug: DEMO.orgSlug })
      .returning({ id: organizations.id });
    const [user] = await tx
      .insert(users)
      .values({ email: DEMO.email, passwordHash, name: 'Demo Owner' })
      .returning({ id: users.id });
    if (!org || !user) throw new Error('seed insert failed');
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: 'owner' });
    const [campaign] = await tx
      .insert(campaigns)
      .values({ orgId: org.id, name: `Forwarding — ${DEMO.number}`, ringTimeoutSec: 25 })
      .returning({ id: campaigns.id });
    if (!campaign) throw new Error('seed campaign failed');
    await tx.insert(phoneNumbers).values({
      orgId: org.id,
      e164: DEMO.number,
      country: 'US',
      numberType: 'toll_free',
      provider: 'mock',
      providerRef: `MOCK${DEMO.number.slice(1)}`,
      status: 'active',
      campaignId: campaign.id,
    });
    await tx.insert(targets).values({
      orgId: org.id,
      campaignId: campaign.id,
      targetType: 'phone',
      name: 'Primary destination',
      destination: DEMO.destination,
      weight: 100,
      priorityTier: 1,
    });
  });
  return { created: true };
}
