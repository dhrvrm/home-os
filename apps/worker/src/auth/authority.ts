import { sessionLifetimeSQL } from "./session-policy";
import type { CommandContext } from "../platform/context";
import { HomeOSError } from "../platform/errors";
import {
  permits,
  ROLES,
  type Action,
  type ActionSubject,
  type Role,
} from "./permissions";
export type AuthorityProof =
  | { kind: "browser"; tokenHash: string; credentialVersion: number }
  | {
      kind: "delegated";
      connectionId: string;
      credentialVersion: number;
      ceiling: Role;
    };
export interface VerifiedAuthority {
  memberId: string;
  householdId: string;
  role: Role;
  proof: AuthorityProof;
}
export function authorityDenied(): HomeOSError {
  return new HomeOSError(
    "Your access changed. Sign in again before continuing.",
    "forbidden",
    403,
  );
}
/** Exact current proof is rechecked inside each acceptance transaction. */
export function authorityPredicate(
  context: CommandContext,
  action: Action,
  subject: ActionSubject = {
    householdId: context.householdId,
    memberId: context.actorId,
  },
): { sql: string; values: (string | number)[] } {
  const authority = context.authority;
  if (
    !authority ||
    authority.memberId !== context.actorId ||
    authority.householdId !== context.householdId
  )
    return { sql: "0", values: [] };
  const roles = ROLES.filter((role) =>
    permits(
      {
        memberId: authority.memberId,
        householdId: authority.householdId,
        role,
        kind: authority.proof.kind,
        ceiling: authority.proof.kind === "delegated" ? authority.proof.ceiling : undefined,
      },
      action,
      subject,
    ),
  );
  if (!roles.length) return { sql: "0", values: [] };
  if (authority.proof.kind === "delegated") {
    return {
      sql: `EXISTS (SELECT 1 FROM mcp_connections c JOIN members m ON m.id = c.member_id JOIN auth_accounts a ON a.member_id = m.id
        WHERE c.id = ? AND c.member_id = ? AND c.household_id = ? AND m.household_id = c.household_id
        AND m.archived_at IS NULL AND m.role IN (${roles.map(() => "?").join(",")})
        AND c.status = 'active' AND c.provider_grant_id IS NOT NULL AND c.established_at IS NOT NULL
        AND c.credential_version = a.credential_version AND c.credential_version = ? AND c.approved_role = ?)`,
      values: [authority.proof.connectionId, authority.memberId, authority.householdId, ...roles, authority.proof.credentialVersion, authority.proof.ceiling],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM auth_sessions s JOIN members m ON m.id = s.member_id JOIN auth_accounts a ON a.member_id = m.id
    WHERE s.token_hash = ? AND m.id = ? AND m.household_id = ? AND m.archived_at IS NULL
    AND m.role IN (${roles.map(() => "?").join(",")})
    AND ${sessionLifetimeSQL('s', "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")}
    AND s.credential_version = a.credential_version AND s.credential_version = ?)`,
    values: [
      authority.proof.tokenHash,
      authority.memberId,
      authority.householdId,
      ...roles,
      authority.proof.credentialVersion,
    ],
  };
}
export async function assertAuthority(
  database: D1Database,
  context: CommandContext,
  action: Action,
  subject?: ActionSubject,
): Promise<void> {
  const predicate = authorityPredicate(context, action, subject);
  const row = await database
    .prepare(`SELECT ${predicate.sql} AS admitted`)
    .bind(...predicate.values)
    .first<{ admitted: number }>();
  if (!row?.admitted) throw authorityDenied();
}
export function authorityGuard(
  database: D1Database,
  context: CommandContext,
  action: Action,
  subject?: ActionSubject,
): D1PreparedStatement {
  const predicate = authorityPredicate(context, action, subject);
  return database
    .prepare(
      `INSERT INTO mutation_guards (household_id, operation_id, expected_version, actual_version) VALUES (?, ?, 1, ${predicate.sql})`,
    )
    .bind(
      context.householdId,
      `${context.operationId}:authority`,
      ...predicate.values,
    );
}
export function releaseAuthorityGuard(
  database: D1Database,
  context: CommandContext,
): D1PreparedStatement {
  return database
    .prepare(
      "DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?",
    )
    .bind(context.householdId, `${context.operationId}:authority`);
}
export async function authorizedBatch(
  database: D1Database,
  context: CommandContext,
  action: Action,
  statements: D1PreparedStatement[],
  subject?: ActionSubject,
): Promise<D1Result[]> {
  try {
    const results = await database.batch([
      authorityGuard(database, context, action, subject),
      ...statements,
      releaseAuthorityGuard(database, context),
    ]);
    return results.slice(1, -1);
  } catch (error) {
    await assertAuthority(database, context, action, subject);
    throw error;
  }
}
