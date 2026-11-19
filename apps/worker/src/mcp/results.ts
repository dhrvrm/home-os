import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertAuthority, permissionIdentity, type VerifiedAuthority } from "../auth/authority";
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
    permissionIdentity(authority),
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
export function registerTool<T extends z.ZodType>(
  server: McpServer,
  context: ToolContext,
  action: Action,
  description: string,
  schema: T,
  readOnly: boolean,
  execute: (input: z.output<T>, command: CommandContext) => Promise<Record<string, unknown>>,
  options: { name?: string; destructive?: boolean } = {},
) {
  if (!permitted(context, action)) return;
  const tool = options.name ?? action;
  server.registerTool(tool, {
    title: tool.replaceAll("_", " "),
    description,
    inputSchema: schema instanceof z.ZodObject ? schema.strict() : schema,
    annotations: readOnly ? readOnlyAnnotations : {
      readOnlyHint: false,
      destructiveHint: options.destructive ?? /_(update|stock|archive|cancel|revoke)$/.test(action),
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (input: unknown) => {
    const values = input as { operationId?: string; expectedVersion?: number };
    const command = commandContext(context, tool, values);
    try {
      await assertAuthority(context.env.DB, command, action);
      const data = await execute(schema.parse(input), command);
      // Financial acknowledgements include current-authorized replay. Existing access
      // commands may intentionally end their own authority and acknowledge that once.
      if (readOnly || action.startsWith('ledger_')) await assertAuthority(context.env.DB, command, action);
      return result(data);
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

/** Bound raw bytes before any JSON parser, including chunked and escaped input. */
export async function boundedLedgerBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const maximum = 64 * 1024;
  const tooLarge = () => new HomeOSError('Ledger requests must be at most 64 KiB', 'payload_too_large', 413);
  if (Number(request.headers.get('content-length')) > maximum) throw tooLarge();
  const bytes = new Uint8Array(maximum);
  const reader = request.body?.getReader();
  let length = 0;
  if (reader) try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maximum) { await reader.cancel(); throw tooLarge(); }
      bytes.set(chunk.value, length); length += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return bytes.slice(0, length);
}
export async function boundedLedgerJSON(request: Request, allowEmpty = false): Promise<unknown> {
  const bytes = await boundedLedgerBody(request);
  try { return allowEmpty && bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('body', 'must contain valid JSON'); }
}
