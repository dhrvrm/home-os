import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import type { CommandContext } from "../platform/context";
import { ConflictError, HomeOSError, ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";
import { assertAuthority, authorizedBatch, type VerifiedAuthority } from "./authority";
import type { Action, ActionSubject, Role } from "./permissions";

export const accessId = /^[a-f0-9]{32}$/;
export interface ConnectionAccess {
  id: string; memberId: string; clientId: string; clientName: string; resource: string;
  approvedRole: Role; status: "authorized" | "not_used_yet" | "ended";
  createdAt: string; approvedAt: string | null; endedAt: string | null;
}
interface ConnectionRow {
  id: string; member_id: string; household_id: string; credential_version: number; client_id: string; client_name: string;
  resource: string; approved_role: Role; status: string; provider_grant_id: string | null; created_at: string;
  approved_at: string | null; established_at: string | null; ended_at: string | null; exchange_until: string;
}
export async function resolveDelegatedAuthority(env: Env, connectionId: unknown, clientId: string, userId: string, resource: string): Promise<VerifiedAuthority | null> {
  if (typeof connectionId !== "string" || !accessId.test(connectionId)) return null;
  const row = await env.DB.prepare(`SELECT c.member_id, c.household_id, c.credential_version, c.approved_role, m.role
    FROM mcp_connections c JOIN members m ON m.id = c.member_id JOIN auth_accounts a ON a.member_id = m.id
    WHERE c.id = ? AND c.client_id = ? AND c.member_id = ? AND c.resource = ? AND c.household_id = ?
    AND m.household_id = c.household_id AND m.archived_at IS NULL AND c.status = 'active'
    AND c.provider_grant_id IS NOT NULL AND c.established_at IS NOT NULL AND c.credential_version = a.credential_version`)
    .bind(connectionId, clientId, userId, resource, env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
    .first<{ member_id: string; household_id: string; credential_version: number; approved_role: Role; role: Role }>();
  return row ? { memberId: row.member_id, householdId: row.household_id, role: row.role, proof: { kind: "delegated", connectionId, credentialVersion: row.credential_version, ceiling: row.approved_role } } : null;
}

/** Shared accepted-access audit. Audit-before-mutation is one guarded transaction. */
export async function acceptedAccessBatch(database: D1Database, context: CommandContext, action: Action, subject: ActionSubject,
  change: { entityType: string; id: string; event: string; exists: string; values: (string | number)[]; statements: D1PreparedStatement[] }): Promise<void> {
  if (!context.operationId || context.operationId.length > 128) throw new ValidationError("operationId", "provide 1 to 128 characters");
  await assertAuthority(database, context, action, subject);
  const replay = async () => {
    const row = await database.prepare(`SELECT actor_id, entity_type, entity_id, action FROM audit_events WHERE household_id = ? AND operation_id = ?`)
      .bind(context.householdId, context.operationId).first<{ actor_id: string; entity_type: string; entity_id: string; action: string }>();
    if (row && row.actor_id === context.actorId && row.entity_type === change.entityType && row.entity_id === change.id && row.action === change.event) return true;
    const used = row || await database.prepare(`SELECT operation_id FROM household_command_receipts WHERE household_id = ? AND operation_id = ? UNION ALL SELECT operation_id FROM processed_operations WHERE household_id = ? AND operation_id = ? LIMIT 1`)
      .bind(context.householdId, context.operationId, context.householdId, context.operationId).first();
    if (used) throw new ConflictError(change.entityType, change.id, 0, 0);
    return false;
  };
  if (await replay()) return;
  try {
    await authorizedBatch(database, context, action, [
      database.prepare(`INSERT INTO mutation_guards (household_id, operation_id, expected_version, actual_version)
        SELECT ?, ?, 1, NOT EXISTS (SELECT 1 FROM audit_events WHERE household_id = ? AND operation_id = ? UNION ALL
        SELECT 1 FROM household_command_receipts WHERE household_id = ? AND operation_id = ? UNION ALL
        SELECT 1 FROM processed_operations WHERE household_id = ? AND operation_id = ?)`)
        .bind(context.householdId, `${context.operationId}:access`, context.householdId, context.operationId, context.householdId, context.operationId, context.householdId, context.operationId),
      database.prepare(`INSERT INTO audit_events (id, household_id, entity_type, entity_id, action, actor_id, actor_type, source, operation_id, server_time, changes_json, device_id, client_time, mcp_client_id, mcp_tool)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ? WHERE ${change.exists}`)
        .bind(createId(), context.householdId, change.entityType, change.id, change.event, context.actorId, context.actorType, context.source, context.operationId, new Date().toISOString(), context.deviceId ?? null, context.clientTime ?? null, context.mcpClientId ?? null, context.mcpTool ?? null, ...change.values),
      ...change.statements,
      database.prepare("DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?").bind(context.householdId, `${context.operationId}:access`),
    ], subject);
  } catch (error) {
    await assertAuthority(database, context, action, subject);
    if (await replay()) return;
    throw error;
  }
}

export class ConnectionAccessService {
  constructor(readonly database: D1Database) {}
  async listConnections(context: CommandContext, input: { memberId?: string; limit?: number; cursor?: string } = {}): Promise<{ connections: ConnectionAccess[]; nextCursor: string | null }> {
    const memberId = input.memberId ?? context.actorId, limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError("limit", "choose 1 to 50 connections");
    if (input.cursor !== undefined && !accessId.test(input.cursor)) throw new ValidationError("cursor", "is invalid");
    const subject = { householdId: context.householdId, memberId };
    await assertAuthority(this.database, context, "connections_list", subject);
    const rows = await this.database.prepare(`SELECT c.* FROM mcp_connections c JOIN members m ON m.id = c.member_id
      WHERE c.household_id = ? AND m.household_id = c.household_id AND c.member_id = ? AND c.id > ? AND c.status <> 'pending' ORDER BY c.id LIMIT ?`)
      .bind(context.householdId, memberId, input.cursor ?? "", limit + 1).all<ConnectionRow>();
    await assertAuthority(this.database, context, "connections_list", subject);
    const page = rows.results.slice(0, limit), now = new Date().toISOString();
    return { connections: page.map(row => ({ id: row.id, memberId: row.member_id, clientId: row.client_id, clientName: row.client_name, resource: row.resource,
      approvedRole: row.approved_role, status: row.status !== "active" || (!row.established_at && row.exchange_until <= now) ? "ended" : row.established_at ? "authorized" : "not_used_yet",
      createdAt: row.created_at, approvedAt: row.approved_at, endedAt: row.ended_at })), nextCursor: rows.results.length > limit ? page.at(-1)!.id : null };
  }
  async revokeConnection(context: CommandContext, id: string): Promise<{ id: string; revoked: true }> {
    if (!accessId.test(id)) throw new ValidationError("id", "is invalid");
    await assertAuthority(this.database, context, "connections_revoke");
    const target = await this.database.prepare("SELECT member_id FROM mcp_connections WHERE id = ? AND household_id = ?").bind(id, context.householdId).first<{ member_id: string }>();
    const subject = { householdId: context.householdId, memberId: target?.member_id ?? context.actorId };
    await acceptedAccessBatch(this.database, context, "connections_revoke", subject, { entityType: "mcp_connection", id, event: "connection.revoked",
      exists: "EXISTS (SELECT 1 FROM mcp_connections WHERE id = ? AND household_id = ? AND member_id = ? AND status IN ('active','pending'))", values: [id, context.householdId, subject.memberId],
      statements: [this.database.prepare(`UPDATE mcp_connections SET status = 'revoked', ended_at = ?, cleanup_pending = 1 WHERE id = ? AND household_id = ? AND member_id = ? AND status IN ('active','pending')`)
        .bind(new Date().toISOString(), id, context.householdId, subject.memberId)] });
    return { id, revoked: true };
  }
}
/** Bounded ingress maintenance, independent of the notification cron's exact budget. */
export async function maintainConnections(env: Env, helpers: OAuthHelpers): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_consent_intents WHERE id IN (SELECT id FROM mcp_consent_intents WHERE expires_at <= ? LIMIT 20)").bind(now),
    env.DB.prepare("DELETE FROM mcp_connections WHERE id IN (SELECT id FROM mcp_connections WHERE status = 'failed' AND cleanup_pending = 0 AND ended_at < ? LIMIT 20)").bind(new Date(Date.now() - 86_400_000).toISOString()),
    env.DB.prepare(`UPDATE mcp_connections SET status = 'failed', ended_at = ?, cleanup_pending = 1 WHERE id IN
      (SELECT id FROM mcp_connections WHERE status IN ('active','pending') AND established_at IS NULL AND exchange_until <= ? LIMIT 20)`).bind(now, now),
  ]);
  const cleanup = await env.DB.prepare(`SELECT id, member_id, provider_grant_id FROM mcp_connections WHERE cleanup_pending = 1 ORDER BY id LIMIT 1`).all<{ id: string; member_id: string; provider_grant_id: string | null }>();
  for (const row of cleanup.results) {
    try {
      if (row.provider_grant_id) await helpers.revokeGrant(row.provider_grant_id, row.member_id);
      await env.DB.prepare("UPDATE mcp_connections SET cleanup_pending = 0 WHERE id = ? AND status IN ('revoked','failed')").bind(row.id).run();
    } catch { /* D1 is already authoritative; retry one public-helper cleanup on later ingress. */ }
  }
}
export function consentChanged(): HomeOSError { return new HomeOSError("This authorization changed or expired. Review the connection again.", "consent_changed", 409); }
