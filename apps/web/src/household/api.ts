import { APIError, request } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import {
  AccessChangedError,
  boundaryMember,
  runHouseholdWork,
  type WorkLease,
} from "@/auth/work";
import { readCopy, writeCopy, type SavedCopy } from "./cache";
export function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}
export function requireIdentity(user: AuthUser, lease: WorkLease): void {
  lease.check();
  const boundary = boundaryMember();
  if (
    lease.memberId !== user.id ||
    (boundary &&
      (boundary.id !== user.id || boundary.householdId !== user.householdId))
  )
    throw new AccessChangedError();
}
export async function householdRead<T>(
  user: AuthUser,
  domain: string,
  path: string,
  valid: (data: unknown) => data is T,
): Promise<SavedCopy<T>> {
  const scopedValid = (data: unknown): data is T =>
    valid(data) && ownsRecords(user, data);
  return runHouseholdWork(async (lease) => {
    requireIdentity(user, lease);
    try {
      if (!online()) throw new APIError("You are offline.", "offline");
      const data: unknown = await request(path);
      requireIdentity(user, lease);
      if (!scopedValid(data))
        throw new APIError(
          "The server returned unreadable household information.",
          "invalid_response",
        );
      return await writeCopy(user, domain, data, lease);
    } catch (error) {
      requireIdentity(user, lease);
      if (
        !(error instanceof APIError) ||
        !["offline", "network_error", "timeout"].includes(error.code)
      )
        throw error;
      const cached = await readCopy(user, domain, scopedValid, lease);
      if (cached) return cached;
      throw new APIError(
        "This section needs a connection before a saved copy is available.",
        "offline",
      );
    }
  });
}
export interface Intent {
  signature: string;
  operationId: string;
}
/** Retry the exact same intent with the same identifier after uncertain transport failure. */
export function operationIntent(
  previous: Intent | null,
  path: string,
  method: string,
  input: unknown,
  version?: number,
): Intent {
  const signature = JSON.stringify([path, method, input, version]);
  return previous?.signature === signature
    ? previous
    : { signature, operationId: crypto.randomUUID() };
}
export async function householdCommand<T>(
  path: string,
  method: string,
  input?: unknown,
  intent?: Intent,
  version?: number,
): Promise<T> {
  if (!online())
    throw new APIError(
      "Connect to the internet to save changes. Your draft stays here.",
      "offline",
    );
  return request(`/api/v1${path}`, {
    method,
    headers: {
      ...(intent ? { "X-Operation-ID": intent.operationId } : {}),
      ...(version === undefined ? {} : { "If-Match": String(version) }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Try again.";
}
export function isConflict(error: unknown): boolean {
  return error instanceof APIError && /conflict|version|stale/.test(error.code);
}

function ownsRecords(user: AuthUser, data: unknown): boolean {
  if (!data || typeof data !== "object") return true;
  if (Array.isArray(data)) return data.every((item) => ownsRecords(user, item));
  const value = data as Record<string, unknown>;
  if (
    typeof value.householdId === "string" &&
    value.householdId !== user.householdId
  )
    return false;
  return Object.values(value).every(
    (child) => !child || typeof child !== "object" || ownsRecords(user, child),
  );
}
