import { sessionLifetimeSQL } from "./session-policy";
import type { CommandContext } from "../platform/context";
import { HomeOSError } from "../platform/errors";
import {
  permits,
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
/** U3 supplies delegated resolution; never consult connection tables before their migration. */
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
    authority.householdId !== context.householdId ||
    authority.proof.kind !== "browser"
  )
    return { sql: "0", values: [] };
  const roles = (["owner", "member", "viewer"] as const).filter((role) =>
    permits(
      {
        memberId: authority.memberId,
        householdId: authority.householdId,
        role,
        kind: authority.proof.kind,
      },
      action,
      subject,
    ),
  );
  if (!roles.length) return { sql: "0", values: [] };
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
    return await database.batch([
      authorityGuard(database, context, action, subject),
      ...statements,
      releaseAuthorityGuard(database, context),
    ]);
  } catch (error) {
    await assertAuthority(database, context, action, subject);
    throw error;
  }
}
