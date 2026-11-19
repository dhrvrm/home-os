import {
  authorityPredicate,
  authorityDenied,
  assertAuthority,
  authorityGuard,
  releaseAuthorityGuard,
} from "../auth/authority";
import { commandAction, type Action } from "../auth/permissions";
import type { CommandContext } from "./context";
import { ConflictError, ValidationError } from "./errors";
import { createId } from "./ids";

export interface HouseholdCommand {
  context: CommandContext;
  entityType:
    | "recipe"
    | "meal"
    | "meal_attendance"
    | "contact"
    | "inventory_item"
    | "expense_rule"
    | "member"
    | "notification_preferences"
    | "notification";
  entityId?: string;
  action: string;
  requestHash: string;
  policyAction: Action;
  changes?: unknown[];
  visibility: "household" | "private";
}

interface Receipt {
  operation_id: string | null;
  authority_admitted: number;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  request_hash: string;
  result_json: string;
}

export function operationConflict(command: HouseholdCommand): ConflictError {
  return new ConflictError(command.entityType, command.entityId ?? "", 0, 0);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export async function beginCommand(
  database: D1Database,
  context: CommandContext,
  entityType: HouseholdCommand["entityType"],
  action: string,
  entityId: string | undefined,
  input: unknown,
  policyAction: Action = commandAction(entityType, action),
  visibility: "household" | "private" = "household",
): Promise<HouseholdCommand> {
  if (!context.operationId || context.operationId.length > 128) {
    throw new ValidationError(
      "operationId",
      "provide an operation ID of 1 to 128 characters",
    );
  }
  await assertAuthority(database, context, policyAction);
  const fingerprint = JSON.stringify(
    canonical({ input, expectedVersion: context.expectedVersion, ...(visibility === "private" ? { source: context.source, mcpClientId: context.mcpClientId, mcpTool: context.mcpTool } : {}) }),
  );
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprint),
  );
  return {
    context,
    entityType,
    entityId,
    action,
    policyAction,
    visibility,
    requestHash: Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export async function replayCommand<T>(
  database: D1Database,
  command: HouseholdCommand,
): Promise<T | null> {
  const { context } = command;
  const predicate = authorityPredicate(
    context,
    command.policyAction,
  );
  const row = await database
    .prepare(
      `SELECT (${predicate.sql}) AS authority_admitted, r.operation_id, r.actor_id, r.entity_type, r.entity_id, r.action, r.request_hash, r.result_json
       FROM (SELECT 1) LEFT JOIN household_command_receipts r ON r.household_id = ? AND r.operation_id = ?`,
    )
    .bind(...predicate.values, context.householdId, context.operationId)
    .first<Receipt>();
  if (!row?.authority_admitted) throw authorityDenied();
  if (row.operation_id !== null) {
    if (
      row.actor_id !== context.actorId ||
      row.entity_type !== command.entityType ||
      row.action !== command.action ||
      row.request_hash !== command.requestHash ||
      (command.entityId !== undefined && row.entity_id !== command.entityId)
    )
      throw operationConflict(command);
    const stored = JSON.parse(row.result_json);
    return (command.visibility === "private" ? stored.acknowledgement : stored) as T;
  }
  const used = await database
    .prepare(
      `SELECT operation_id FROM audit_events WHERE household_id = ? AND operation_id = ?
     UNION ALL
     SELECT operation_id FROM processed_operations WHERE household_id = ? AND operation_id = ? LIMIT 1`,
    )
    .bind(
      context.householdId,
      context.operationId,
      context.householdId,
      context.operationId,
    )
    .first();
  if (used) throw operationConflict(command);
  return null;
}

export function commandGuard(
  database: D1Database,
  command: HouseholdCommand,
  expected: number,
  query: string,
  values: (string | number | null)[],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO mutation_guards (household_id, operation_id, expected_version, actual_version)
     VALUES (?, ?, ?, COALESCE((${query}), -1))`,
    )
    .bind(
      command.context.householdId,
      command.context.operationId,
      expected,
      ...values,
    );
}

function auditChanges(command: HouseholdCommand, result: unknown): unknown[] {
  if (command.changes) return command.changes;
  const state = result as Record<string, unknown>;
  if (command.entityType === "meal_attendance") {
    // Retain the accepted answer when the current attendance row is replaced.
    return [{ field: "attendance", before: null, after: state.myAttendance }];
  }
  // These domain DTOs contain household facts, never session or push credentials.
  // A meal command changes its announcement, not the other members' answers.
  const accepted = Object.fromEntries(
    Object.entries(state).filter(
      ([key]) => !["attendance", "myAttendance", "availability"].includes(key),
    ),
  );
  return [{ field: command.entityType, before: null, after: accepted }];
}

export async function commitCommand<T>(
  database: D1Database,
  command: HouseholdCommand,
  result: T,
  entityId: string,
  now: string,
  statements: D1PreparedStatement[],
  onConflict: () => Promise<void>,
  acceptedResult?: { query: string; values: (string | number | null)[] },
): Promise<T> {
  const { context } = command;
  const actorGuard = authorityGuard(
    database,
    context,
    command.policyAction,
  );
  const release = (operationId: string) =>
    database
      .prepare(
        "DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?",
      )
      .bind(context.householdId, operationId);
  try {
    const accepted = await database.batch([
      actorGuard,
      ...statements,
      database
        .prepare(
          `INSERT INTO household_command_receipts
         (household_id, operation_id, actor_id, entity_type, entity_id, action, request_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${acceptedResult ? `(${acceptedResult.query})` : "?"}, ?)`,
        )
        .bind(
          context.householdId,
          context.operationId,
          context.actorId,
          command.entityType,
          entityId,
          command.action,
          command.requestHash,
          ...(acceptedResult
            ? acceptedResult.values
            : [JSON.stringify(command.visibility === "private" ? { acknowledgement: result, provenance: { source: context.source, clientId: context.mcpClientId ?? null, tool: context.mcpTool ?? null } } : result)]),
          now,
        ),
      ...(command.visibility === "private" ? [] : [database
        .prepare(
          `INSERT INTO audit_events
         (id, household_id, entity_type, entity_id, action, actor_id, actor_type, source, device_id,
          operation_id, client_time, server_time, changes_json, mcp_client_id, mcp_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          createId(),
          context.householdId,
          command.entityType,
          entityId,
          command.action,
          context.actorId,
          context.actorType,
          context.source,
          context.deviceId ?? null,
          context.operationId,
          context.clientTime ?? null,
          now,
          JSON.stringify(auditChanges(command, result)),
          context.mcpClientId ?? null,
          context.mcpTool ?? null,
        )]),
      release(context.operationId),
      releaseAuthorityGuard(database, context),
      ...(acceptedResult
        ? [
            database
              .prepare(`SELECT (${acceptedResult.query}) AS result_json`)
              .bind(...acceptedResult.values),
          ]
        : []),
    ]);
    return acceptedResult
      ? (JSON.parse(
          (accepted.at(-1)!.results[0] as { result_json: string }).result_json,
        ) as T)
      : structuredClone(result);
  } catch (error) {
    const replay = await replayCommand<T>(database, command);
    if (replay !== null) return replay;
    await assertAuthority(
      database,
      context,
      command.policyAction,
    );
    await onConflict();
    throw error;
  }
}

export function expectedVersion(context: CommandContext): number {
  if (
    !Number.isSafeInteger(context.expectedVersion) ||
    (context.expectedVersion ?? 0) < 1
  ) {
    throw new ValidationError("If-Match", "provide the version you last read");
  }
  return context.expectedVersion!;
}
