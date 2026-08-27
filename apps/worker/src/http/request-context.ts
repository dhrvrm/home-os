import type { Context } from "hono";
import type { AppContext } from "../auth/context";
import type { CommandContext } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";

export function commandContext(context: Context<AppContext>): CommandContext {
  const auth = context.get("auth");
  if (!auth.household || !auth.membershipId) {
    throw new Error("Authenticated household context is missing.");
  }
  const operationId = context.req.header("X-Operation-ID")?.trim() || createId();
  if (operationId.length > 128) {
    throw new ValidationError("operationId", "must be 128 characters or fewer");
  }
  const expectedVersion = parseExpectedVersion(context.req.header("If-Match"));
  return {
    householdId: auth.household.id,
    actorId: auth.membershipId,
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
