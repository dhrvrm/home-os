import type { Context } from "hono";
import type { Env } from "../env";
import type { CommandContext } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";

export function commandContext(context: Context<{ Bindings: Env }>): CommandContext {
  const operationId = context.req.header("X-Operation-ID")?.trim() || createId();
  if (operationId.length > 128) {
    throw new ValidationError("operationId", "must be 128 characters or fewer");
  }
  const expectedVersion = parseExpectedVersion(context.req.header("If-Match"));
  return {
    householdId: context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
    actorId: "local-owner",
    actorType: "member",
    source: "pwa",
    operationId,
    expectedVersion,
    deviceId: context.req.header("X-Device-ID")?.trim() || undefined,
    clientTime: context.req.header("X-Client-Time")?.trim() || undefined,
  };
}

function parseExpectedVersion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(?:W\/)?"?(\d+)"?$/);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("If-Match", "must contain a positive item version");
  }
  return version;
}
