import { ValidationError } from "./errors";
import type { ActorType, CommandSource } from "./context";
import type { AuditChange } from "../inventory/repository";

export interface AuditEvent {
  sequence: number;
  id: string;
  householdId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  actorType: ActorType;
  source: CommandSource;
  deviceId: string | null;
  operationId: string;
  clientTime: string | null;
  serverTime: string;
  changes: AuditChange[];
  mcpClientId: string | null;
  mcpTool: string | null;
}

export interface AuditFilter {
  after?: string;
  limit?: number;
  entityType?: string;
  entityId?: string;
  actorId?: string;
}

interface AuditRow {
  sequence: number;
  id: string;
  household_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_type: ActorType;
  source: CommandSource;
  device_id: string | null;
  operation_id: string;
  client_time: string | null;
  server_time: string;
  changes_json: string;
  mcp_client_id: string | null;
  mcp_tool: string | null;
}

export async function listAuditEvents(
  database: D1Database,
  householdId: string,
  filter: AuditFilter,
): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
  const after = decodeCursor(filter.after);
  const clauses = ["household_id = ?", "sequence > ?"];
  const values: Array<string | number> = [householdId, after];

  for (const [column, value] of [
    ["entity_type", filter.entityType],
    ["entity_id", filter.entityId],
    ["actor_id", filter.actorId],
  ] as const) {
    if (!value) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }

  const result = await database
    .prepare(
      `SELECT sequence, id, household_id, entity_type, entity_id, action,
              actor_id, actor_type, source, device_id, operation_id,
              client_time, server_time, changes_json, mcp_client_id, mcp_tool
         FROM audit_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY sequence ASC
        LIMIT ?`,
    )
    .bind(...values, limit + 1)
    .all<AuditRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const events = rows.map(mapAuditRow);
  const nextCursor = hasMore && events.length ? encodeCursor(events.at(-1)!.sequence) : null;
  return { events, nextCursor };
}

function mapAuditRow(row: AuditRow): AuditEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    householdId: row.household_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    source: row.source,
    deviceId: row.device_id,
    operationId: row.operation_id,
    clientTime: row.client_time,
    serverTime: row.server_time,
    changes: JSON.parse(row.changes_json) as AuditChange[],
    mcpClientId: row.mcp_client_id,
    mcpTool: row.mcp_tool,
  };
}

function encodeCursor(sequence: number): string {
  return btoa(String(sequence));
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const sequence = Number(atob(cursor));
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid cursor");
    return sequence;
  } catch {
    throw new ValidationError("after", "must be a valid activity cursor");
  }
}
