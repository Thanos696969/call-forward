import { and, eq, memberships, organizations, users } from '@relay/db';
import type { MeDto, OrgDto, Role } from '@relay/core';
import { notFound } from '../lib/errors';
import { isoReq } from '../lib/http';
import type { AppDeps } from '../types';

type OrgRow = typeof organizations.$inferSelect;

export function toOrgDto(o: OrgRow): OrgDto {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    timezone: o.timezone,
    status: o.status,
    createdAt: isoReq(o.createdAt),
  };
}

export async function loadMe(
  deps: AppDeps,
  auth: { userId: string; orgId: string },
): Promise<MeDto> {
  const [row] = await deps.db
    .select({ user: users, org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, auth.userId), eq(memberships.orgId, auth.orgId)))
    .limit(1);
  if (!row) throw notFound('Membership');
  return {
    user: { id: row.user.id, email: row.user.email, name: row.user.name },
    org: toOrgDto(row.org),
    role: row.role as Role,
  };
}

export async function getOrg(deps: AppDeps, orgId: string): Promise<OrgRow> {
  const [org] = await deps.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw notFound('Organisation');
  return org;
}
