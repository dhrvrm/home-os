import type { CommandContext } from "../platform/context";
import { z } from "zod";
import { createId } from "../platform/ids";
import type { AuthContext } from "./session";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(128, "Use at most 128 characters.");
export const nameSchema = z.string().trim().min(1).max(80);
export function accessAudit(context: AuthContext, actorId: string, entityId: string, action: string, acceptedPasswordHash?: string, command?: CommandContext): D1PreparedStatement {
  return context.env.DB.prepare(
    `INSERT INTO audit_events (id, household_id, entity_type, entity_id, action, actor_id,
      actor_type, source, operation_id, server_time, changes_json, device_id, client_time, mcp_client_id, mcp_tool)
     SELECT ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?
     ${acceptedPasswordHash ? "WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE member_id = ? AND password_hash = ?)" : ""}`,
  ).bind(createId(), command?.householdId ?? context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID, entityId, action, command?.actorId ?? actorId, command?.actorType ?? "member", command?.source ?? "pwa", command?.operationId ?? createId(), new Date().toISOString(), command?.deviceId ?? null, command?.clientTime ?? null, command?.mcpClientId ?? null, command?.mcpTool ?? null, ...(acceptedPasswordHash ? [entityId, acceptedPasswordHash] : []));
}
