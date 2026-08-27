import type { Env } from "../env";
import { createAuth } from "./auth";
import { resolveOrganizationHousehold, type DomainHousehold } from "./households";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface AuthOrganization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
}

export interface RequestAuth {
  user: AuthUser;
  sessionId: string;
  organizations: AuthOrganization[];
  organization: AuthOrganization | null;
  membershipId: string | null;
  role: string | null;
  household: DomainHousehold | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

interface MembershipRow {
  id: string;
  role: string;
}

export async function resolveRequestAuth(request: Request, env: Env): Promise<RequestAuth | null> {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return null;

  const organizations = await env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.logo
     FROM organization o
     INNER JOIN member m ON m.organizationId = o.id
     WHERE m.userId = ?
     ORDER BY o.createdAt ASC, o.id ASC`,
  )
    .bind(session.user.id)
    .all<OrganizationRow>();

  const organizationList = organizations.results.map(toOrganization);
  const activeOrganizationId = session.session.activeOrganizationId;
  if (!activeOrganizationId) {
    return {
      user: session.user,
      sessionId: session.session.id,
      organizations: organizationList,
      organization: null,
      membershipId: null,
      role: null,
      household: null,
    };
  }

  const organization = organizationList.find(({ id }) => id === activeOrganizationId) ?? null;
  if (!organization) {
    return {
      user: session.user,
      sessionId: session.session.id,
      organizations: organizationList,
      organization: null,
      membershipId: null,
      role: null,
      household: null,
    };
  }

  const membership = await env.DB.prepare(
    `SELECT id, role FROM member WHERE organizationId = ? AND userId = ?`,
  )
    .bind(organization.id, session.user.id)
    .first<MembershipRow>();
  if (!membership) return null;

  const household = await resolveOrganizationHousehold(
    env.DB,
    organization,
    env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
  );
  return {
    user: session.user,
    sessionId: session.session.id,
    organizations: organizationList,
    organization,
    membershipId: membership.id,
    role: membership.role,
    household,
  };
}

function toOrganization(row: OrganizationRow): AuthOrganization {
  return { id: row.id, name: row.name, slug: row.slug, logo: row.logo };
}
