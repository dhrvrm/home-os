import { AccessChangedError, runHouseholdWork, signalSessionExpired, type WorkLease } from "@/auth/work";
import { online, requireIdentity } from "@/household/api";
import { cacheKey } from "@/household/cache";
import { APIError, request } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import { homeOSDatabase } from "@/offline/db";
import { dispatchCommand, ledgerQuery, LedgerRequestError, validReference } from "./api";
import type { AcceptedReference, CommandResult, LedgerCommand } from "./types";
export const ATTEMPT_NAMESPACE = "ledger:attempt:v1";
export interface RetainedAttempt { phase: "unknown" | "locked"; command: LedgerCommand; retainedAt: string; mayHaveOtherRequest: boolean; message?: string }
export type AttemptOutcome = { kind: "accepted"; reference: AcceptedReference; result?: CommandResult } | { kind: "unknown" | "locked"; attempt: RetainedAttempt } | { kind: "refused"; error: Error } | { kind: "empty" };
/** Counts only local recovery information; this is never an offline sending queue. */
export async function countPendingMoneyAttempts(): Promise<number> { return (await homeOSDatabase.householdCache.toCollection().primaryKeys()).filter(key => { try { return JSON.parse(key)[2] === ATTEMPT_NAMESPACE; } catch { return false; } }).length; }
async function load(user: AuthUser, lease: WorkLease): Promise<RetainedAttempt | null> {
  requireIdentity(user, lease); const row = await homeOSDatabase.householdCache.get(cacheKey(user, ATTEMPT_NAMESPACE)); requireIdentity(user, lease);
  if (!row) return null;
  const value = row.data as RetainedAttempt;
  if (row.householdId !== user.householdId || row.memberId !== user.id || !value || !["unknown", "locked"].includes(value.phase) || !value.command || typeof value.command.operationId !== "string") throw new Error("Retained save information is unreadable. Keep this device's data and sign in again before recovering.");
  return value;
}
export function readAttempt(user: AuthUser): Promise<RetainedAttempt | null> { return runHouseholdWork(lease => load(user, lease)); }
async function replace(user: AuthUser, attempt: RetainedAttempt, lease: WorkLease, next?: RetainedAttempt, ordinaryRefusal = false): Promise<RetainedAttempt | null> {
  const result = await homeOSDatabase.transaction("rw", homeOSDatabase.householdCache, async () => {
    requireIdentity(user, lease); const current = await load(user, lease);
    if (!current || JSON.stringify(current.command) !== JSON.stringify(attempt.command)) throw new AccessChangedError();
    // Another tab may have replayed while this request was in flight. Its marker
    // is monotonic and is inspected in the same transaction as any clearing.
    let retained = next ? { ...next, mayHaveOtherRequest: !!current.mayHaveOtherRequest || !!next.mayHaveOtherRequest } : null;
    if (!retained && ordinaryRefusal && current.mayHaveOtherRequest) retained = { ...current, phase: "unknown", message: "This request was refused, but an earlier or concurrent request may still have been recorded. Keep the original save and check its status." };
    if (retained) await homeOSDatabase.householdCache.put({ key: cacheKey(user, ATTEMPT_NAMESPACE), householdId: user.householdId, memberId: user.id, data: retained, savedAt: retained.retainedAt });
    else await homeOSDatabase.householdCache.delete(cacheKey(user, ATTEMPT_NAMESPACE));
    requireIdentity(user, lease);
    return retained;
  });
  requireIdentity(user, lease);
  return result;
}
function reference(command: LedgerCommand, result: CommandResult): AcceptedReference { return "comment" in result ? { status: "accepted", entryId: result.comment.entryId, version: result.comment.observedVersion, action: "comment", commentId: result.comment.id } : { status: "accepted", entryId: result.entry.id, version: result.entry.version, action: command.action }; }
function matchesReference(command: LedgerCommand, value: AcceptedReference): boolean {
  if (value.action !== command.action) return false;
  if (command.action === "create" || command.action === "post") return value.version === 1 && value.commentId === undefined;
  return value.entryId === command.entryId && value.version === command.expectedVersion + (command.action === "comment" ? 0 : 1) && (command.action === "comment" ? !!value.commentId : value.commentId === undefined);
}
async function failure(user: AuthUser, attempt: RetainedAttempt, lease: WorkLease, error: unknown): Promise<AttemptOutcome> {
  requireIdentity(user, lease);
  const locked = error instanceof LedgerRequestError && [401, 403].includes(error.status) || error instanceof APIError && ["unauthorized", "forbidden", "session_changed"].includes(error.code);
  if (locked) {
    const next: RetainedAttempt = { ...attempt, phase: "locked", mayHaveOtherRequest: true, message: "Recovery locked. Sign in as the same person to check this save; it may already have been recorded." };
    const retained = await replace(user, attempt, lease, next);
    if (error instanceof LedgerRequestError && error.status === 401) signalSessionExpired(lease.proof);
    return { kind: "locked", attempt: retained! };
  }
  const definitive = error instanceof LedgerRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) && error.code !== "invalid_response";
  if (definitive) { const retained = await replace(user, attempt, lease, undefined, true); return retained ? { kind: "unknown", attempt: retained } : { kind: "refused", error }; }
  const next: RetainedAttempt = { ...attempt, phase: "unknown", mayHaveOtherRequest: true, message: "Save outcome unknown. This may already have been recorded. Check status or replay this same save." };
  const retained = await replace(user, attempt, lease, next); return { kind: "unknown", attempt: retained! };
}
async function send(user: AuthUser, attempt: RetainedAttempt, lease: WorkLease): Promise<AttemptOutcome> {
  requireIdentity(user, lease);
  if (user.role === "viewer") { const next: RetainedAttempt = { ...attempt, phase: "locked", message: "Viewers cannot replay financial changes. Your retained save remains available for authorized recovery." }; await replace(user, attempt, lease, next); return { kind: "locked", attempt: next }; }
  try {
    const result = await dispatchCommand(attempt.command); requireIdentity(user, lease);
    if ("entry" in result && result.entry.householdId !== user.householdId || "comment" in result && result.comment.authorId !== user.id) throw new APIError("Unreadable save ownership", "invalid_response");
    await replace(user, attempt, lease); return { kind: "accepted", reference: reference(attempt.command, result), result };
  } catch (error) { return failure(user, attempt, lease, error); }
}
/** Never accepts a second intent while any unresolved slot exists, including from another tab. */
export function submitAttempt(user: AuthUser, command: LedgerCommand): Promise<AttemptOutcome> {
  // Clone before any await: callers cannot mutate the retained payload through their draft.
  const frozen = JSON.parse(JSON.stringify(command)) as LedgerCommand;
  return runHouseholdWork(async lease => {
    requireIdentity(user, lease);
    if (user.role === "viewer") throw new APIError("Viewers can inspect shared finances but cannot save changes.", "forbidden");
    if (!online()) throw new APIError("Connect to save. Your input remains unsaved.", "offline");
    let acquired = false;
    const attempt = await homeOSDatabase.transaction("rw", homeOSDatabase.householdCache, async () => {
      const existing = await load(user, lease); if (existing) return existing;
      const next: RetainedAttempt = { phase: "unknown", command: frozen, retainedAt: new Date().toISOString(), mayHaveOtherRequest: false };
      await homeOSDatabase.householdCache.add({ key: cacheKey(user, ATTEMPT_NAMESPACE), householdId: user.householdId, memberId: user.id, data: next, savedAt: next.retainedAt });
      requireIdentity(user, lease); acquired = true; return next;
    }).catch(error => { if (error instanceof AccessChangedError) throw error; throw new Error(`Could not prepare this save. Your input is still unsaved. ${error instanceof Error ? error.message : "Device storage is unavailable."}`); });
    requireIdentity(user, lease);
    if (!acquired) return { kind: attempt.phase, attempt };
    return send(user, attempt, lease);
  });
}
export function replayAttempt(user: AuthUser): Promise<AttemptOutcome> { return runHouseholdWork(async lease => { const attempt = await load(user, lease); if (!attempt) return { kind: "empty" }; const marked = await replace(user, attempt, lease, { ...attempt, mayHaveOtherRequest: true }); return send(user, marked!, lease); }); }
export function checkAttempt(user: AuthUser): Promise<AttemptOutcome> { return runHouseholdWork(async lease => {
  const attempt = await load(user, lease); if (!attempt) return { kind: "empty" };
  if (!online()) return { kind: attempt.phase, attempt };
  try {
    const result: unknown = await request(ledgerQuery(`/operations/${encodeURIComponent(attempt.command.operationId)}`)); requireIdentity(user, lease);
    if (validReference(result) && matchesReference(attempt.command, result)) { await replace(user, attempt, lease); return { kind: "accepted", reference: result }; }
    if (!result || typeof result !== "object" || !("status" in result) || result.status !== "unknown") throw new APIError("Unreadable operation status", "invalid_response");
    const next: RetainedAttempt = { ...attempt, phase: "unknown", mayHaveOtherRequest: true, message: "Not confirmed yet. An outstanding request may still be recorded. Keep checking or replay this same save." }; const retained = await replace(user, attempt, lease, next); return { kind: "unknown", attempt: retained! };
  } catch (error) { return failure(user, attempt, lease, error); }
}); }
