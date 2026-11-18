import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertAuthority, type VerifiedAuthority } from "../auth/authority";
import { permits, type Action } from "../auth/permissions";
import type { Env } from "../env";
import type { CommandContext } from "../platform/context";
import { ConflictError, HomeOSError, ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";

export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const mutationInput = z.object({ operationId: z.string().trim().min(1).max(128) });
export const versionInput = mutationInput.extend({ expectedVersion: z.number().int().min(1) });
export const subjectId = z.string().trim().min(1).max(128);

export interface ToolContext {
  env: Env;
  authority: VerifiedAuthority;
  clientId: string;
}

export function commandContext(
  context: ToolContext,
  tool: string,
  input: { operationId?: string; expectedVersion?: number } = {},
): CommandContext {
  return {
    authority: context.authority,
    householdId: context.authority.householdId,
    actorId: context.authority.memberId,
    actorType: "mcp",
    source: "mcp",
    operationId: input.operationId ?? createId(),
    expectedVersion: input.expectedVersion,
    mcpClientId: context.clientId,
    mcpTool: tool,
  };
}

export function permitted(context: ToolContext, action: Action): boolean {
  const authority = context.authority;
  return permits(
    {
      memberId: authority.memberId,
      householdId: authority.householdId,
      role: authority.role,
      kind: authority.proof.kind,
      ceiling: authority.proof.kind === "delegated" ? authority.proof.ceiling : undefined,
    },
    action,
    { householdId: authority.householdId, memberId: authority.memberId },
  );
}

export function result(data: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

export function failure(error: unknown) {
  if (error instanceof ConflictError) {
    return result({
      status: "conflict",
      code: error.code,
      message: error.message,
      entityId: error.entityId,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
      ...(error.details ? { current: error.details } : {}),
    }, true);
  }
  if (error instanceof HomeOSError) {
    return result({
      status: error instanceof ValidationError ? "invalid" : "refused",
      code: error.code,
      message: error.message,
      ...(error instanceof ValidationError ? { field: error.field } : {}),
    }, true);
  }
  // Operational diagnostics and secret-bearing binding errors never enter household results.
  return result({
    status: "unavailable",
    code: "temporarily_unavailable",
    message: "The household service is temporarily unavailable. Retry the same operation ID.",
  }, true);
}

/** Services retain subject-specific checks and atomic acceptance; this covers transport admission. */
export function registerTool<T extends z.ZodRawShape>(
  server: McpServer,
  context: ToolContext,
  action: Action,
  description: string,
  schema: z.ZodObject<T>,
  readOnly: boolean,
  execute: (input: z.output<z.ZodObject<T>>, command: CommandContext) => Promise<Record<string, unknown>>,
) {
  if (!permitted(context, action)) return;
  server.registerTool(action, {
    title: action.replaceAll("_", " "),
    description,
    inputSchema: schema.strict(),
    annotations: readOnly ? readOnlyAnnotations : {
      readOnlyHint: false,
      destructiveHint: /_(update|stock|archive)$/.test(action),
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async input => {
    const values = input as { operationId?: string; expectedVersion?: number };
    const command = commandContext(context, action, values);
    try {
      await assertAuthority(context.env.DB, command, action);
      return result(await execute(input, command));
    } catch (error) {
      // A changed authority cannot inspect even a stale version or previous receipt outcome.
      try {
        await assertAuthority(context.env.DB, command, action);
      } catch (admissionError) {
        return failure(admissionError);
      }
      return failure(error);
    }
  });
}
