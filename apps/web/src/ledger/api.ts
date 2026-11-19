import { APIError, request } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import { captureAccessProof, runHouseholdWork } from "@/auth/work";
import { online, requireIdentity } from "@/household/api";
import { readCopy, writeCopy, type SavedCopy } from "@/household/cache";
import { homeOSDatabase } from "@/offline/db";
import { MAX_ENTRY_MINOR, MAX_PARTICIPANTS, previewAllocation, previewItemizedBill } from "./allocation-preview";
import type { AcceptedReference, CommandResult, Currency, ExpenseInput, LedgerCommand, LedgerEntry, ResolvedExpense, RecurringPostingSource, Share, SplitIntent, ItemizedIntent, StatementExport, StatementMovement, StatementScope } from "./types";

import { object, positiveInteger, validDate } from "./validation";

export class LedgerRequestError extends APIError {
  constructor(message: string, code: string, public readonly status: number, field?: string, public readonly details?: unknown) { super(message, code, field); }
}
export function commandRequest(command: LedgerCommand): { path: string; method: string; body: unknown; version?: number } {
  switch (command.action) {
    case "create": return { path: `/${command.entry.kind === "expense" ? "expenses" : command.entry.kind === "refund" ? "refunds" : "payments"}`, method: "POST", body: command.entry };
    case "correct": return { path: `/entries/${encodeURIComponent(command.entryId)}`, method: "PUT", body: command.entry, version: command.expectedVersion };
    case "void": case "restore": return { path: `/entries/${encodeURIComponent(command.entryId)}/${command.action}`, method: "POST", body: {}, version: command.expectedVersion };
    case "comment": return { path: `/entries/${encodeURIComponent(command.entryId)}/comments`, method: "POST", body: { text: command.text }, version: command.expectedVersion };
    case "post": { const { action: _action, operationId: _id, ...body } = command; void _action; void _id; return { path: "/rule-postings", method: "POST", body }; }
  }
}
/** Used only by the durable attempt workflow. Retain before invoking this transport. */
export async function dispatchCommand(command: LedgerCommand): Promise<CommandResult> {
  if (!online()) throw new APIError("Connect to recover this save. Nothing is sent automatically.", "offline");
  const spec = commandRequest(command);
  const proof = captureAccessProof();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try { response = await fetch(`${(process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1/ledger${spec.path}`, { method: spec.method, credentials: "same-origin", signal: controller.signal, headers: { "Content-Type": "application/json", ...(proof.memberId ? { "X-HomeOS-Member": proof.memberId } : {}), "X-Operation-ID": command.operationId, ...(spec.version === undefined ? {} : { "If-Match": String(spec.version) }) }, body: JSON.stringify(spec.body) }); }
    catch { throw new APIError("Save outcome unknown. This may already have been recorded.", controller.signal.aborted ? "timeout" : "network_error"); }
    let envelope: { data?: unknown; error?: { code?: string; message?: string; field?: string; details?: unknown } | null };
    try { envelope = await response.json(); }
    catch { throw new LedgerRequestError("The server returned an unreadable response.", "invalid_response", response.status); }
    if (!response.ok || envelope?.error) throw new LedgerRequestError(envelope?.error?.message ?? "The save could not be confirmed.", envelope?.error?.code ?? "request_failed", response.status, envelope?.error?.field, [401, 403].includes(response.status) || ["unauthorized", "forbidden", "session_changed"].includes(envelope?.error?.code ?? "") ? undefined : envelope?.error?.details);
    if (!validCommandResult(envelope?.data, command)) throw new LedgerRequestError("The server returned an unreadable save result.", "invalid_response", response.status);
    return envelope.data;
  } finally { window.clearTimeout(timer); }
}
export function validReference(value: unknown): value is AcceptedReference { return object(value) && value.status === "accepted" && typeof value.entryId === "string" && positiveInteger(value.version) && typeof value.action === "string" && (value.commentId === undefined || typeof value.commentId === "string"); }
const date = (value: unknown): value is string => typeof value === "string" && validDate(value);
function validShares(value: unknown, total: number): value is Share[] { return Array.isArray(value) && value.length > 0 && value.length <= MAX_PARTICIPANTS && value.every(p => object(p) && typeof p.memberId === "string" && typeof p.amountMinor === "number" && Number.isSafeInteger(p.amountMinor) && p.amountMinor >= 0 && p.amountMinor <= MAX_ENTRY_MINOR) && new Set(value.map(p => p.memberId)).size === value.length && value.reduce((sum, p) => sum + BigInt(p.amountMinor), BigInt(0)) === BigInt(total); }
const sameShares = (a: Share[], b: Share[]) => a.length === b.length && a.every((share, i) => b[i]?.memberId === share.memberId && b[i]?.amountMinor === share.amountMinor);
/** A readable accepted financial fact includes valid intent and conserving resolved sides. */
export function validLedgerEntry(value: unknown): value is LedgerEntry {
  if (!object(value) || typeof value.id !== "string" || typeof value.householdId !== "string" || !positiveInteger(value.version) || !["effective", "void"].includes(String(value.lifecycle)) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || !object(value.intent)) return false;
  const input = value.intent;
  if (!["expense", "refund", "payment"].includes(String(input.kind)) || !["INR", "USD", "EUR", "GBP", "JPY"].includes(String(input.currency)) || !positiveInteger(input.totalMinor) || input.totalMinor > MAX_ENTRY_MINOR || !date(input.date) || !Array.isArray(value.payers) || !Array.isArray(value.shares)) return false;
  if (input.kind === "payment") return typeof input.senderId === "string" && typeof input.receiverId === "string" && input.senderId !== input.receiverId && typeof input.method === "string" && input.method.trim().length > 0 && [...input.method].length <= 200 && value.payers.length === 0 && value.shares.length === 0;
  if (typeof input.description !== "string" || !input.description.trim() || [...input.description].length > 160 || !validShares(input.payers, input.totalMinor) || !validShares(value.payers, input.totalMinor) || !sameShares(input.payers, value.payers) || !validShares(value.shares, input.totalMinor) || new Set([...value.payers, ...value.shares].map(p => p.memberId)).size > MAX_PARTICIPANTS) return false;
  if (input.kind === "refund") return typeof input.expenseId === "string" && validShares(input.shares, input.totalMinor) && sameShares(input.shares, value.shares);
  if (!object(input.allocation)) return false;
  try {
    if (input.allocation.kind === "split" && object(input.allocation.split)) return sameShares(previewAllocation(input.totalMinor, input.allocation.split as unknown as SplitIntent), value.shares);
    if (input.allocation.kind === "itemized") { const resolved = previewItemizedBill(input.allocation as unknown as ItemizedIntent); return resolved.totalMinor === input.totalMinor && sameShares(resolved.shares, value.shares); }
  } catch { return false; }
  return false;
}
export function validCommandResult(value: unknown, command: LedgerCommand): value is CommandResult {
  if (!object(value) || value.status !== "accepted") return false;
  if (command.action === "comment") return object(value.comment) && typeof value.comment.id === "string" && value.comment.entryId === command.entryId && value.comment.observedVersion === command.expectedVersion && value.comment.text === command.text.trim() && typeof value.comment.authorId === "string" && typeof value.comment.acceptedAt === "string" && Number.isFinite(Date.parse(value.comment.acceptedAt));
  if (!validLedgerEntry(value.entry)) return false;
  const entry = value.entry;
  if (command.action === "create" || command.action === "correct") {
    if (entry.intent.kind !== command.entry.kind || entry.intent.currency !== command.entry.currency || entry.intent.totalMinor !== command.entry.totalMinor || entry.intent.date !== command.entry.date) return false;
  }
  if (command.action === "create" || command.action === "post") { if (entry.version !== 1 || entry.lifecycle !== "effective") return false; }
  else if (entry.id !== command.entryId || entry.version !== command.expectedVersion + 1 || entry.lifecycle !== (command.action === "void" ? "void" : "effective")) return false;
  if (command.action === "post" && (entry.intent.kind !== "expense" || entry.intent.date !== command.date || entry.source?.ruleId !== command.ruleId || entry.source.ruleVersion !== command.expectedRuleVersion || entry.source.period !== command.period)) return false;
  return true;
}
export function ledgerQuery(path: string, query: Record<string, string | number | undefined> = {}): string { const search = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value)); return `/api/v1/ledger${path}${search.size ? `?${search}` : ""}`; }
/** Read snapshots are bounded separately from the durable attempt namespace. */
export async function ledgerRead<T>(user: AuthUser, path: string, valid: (value: unknown) => value is T, kind: "query" | "detail" = "query"): Promise<SavedCopy<T>> {
  const domain = `ledger:read:${kind}:${path}`;
  return runHouseholdWork(async lease => {
    requireIdentity(user, lease);
    try {
      if (!online()) throw new APIError("Offline", "offline");
      const value: unknown = await request(path);
      requireIdentity(user, lease);
      if (!valid(value) || !ownsData(value, user)) throw new APIError("The server returned unreadable financial information.", "invalid_response");
      const copy = await writeCopy(user, domain, value, lease);
      await homeOSDatabase.transaction("rw", homeOSDatabase.householdCache, async () => {
        requireIdentity(user, lease);
        const prefix = `ledger:read:${kind}:`;
        const rows = (await homeOSDatabase.householdCache.where("memberId").equals(user.id).toArray()).filter(row => row.householdId === user.householdId && (() => { try { return String(JSON.parse(row.key)[2]).startsWith(prefix); } catch { return false; } })()).sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.key.localeCompare(b.key));
        const keep = kind === "detail" ? 10 : 20;
        if (rows.length > keep) await homeOSDatabase.householdCache.bulkDelete(rows.slice(keep).map(row => row.key));
        requireIdentity(user, lease);
      });
      return copy;
    } catch (error) {
      requireIdentity(user, lease);
      if (!(error instanceof APIError) || !["offline", "network_error", "timeout"].includes(error.code)) throw error;
      const cached = await readCopy(user, domain, (value): value is T => valid(value) && ownsData(value, user), lease);
      if (cached) return cached;
      throw error;
    }
  });
}
function ownsData(value: unknown, user: AuthUser): boolean { if (!value || typeof value !== "object") return true; if (Array.isArray(value)) return value.every(child => ownsData(child, user)); const row = value as Record<string, unknown>; return (typeof row.householdId !== "string" || row.householdId === user.householdId) && Object.values(row).every(child => ownsData(child, user)); }
export async function previewExpense(user: AuthUser, input: ExpenseInput): Promise<{ allocation: ResolvedExpense }> { return runHouseholdWork(async lease => { requireIdentity(user, lease); if (!online()) throw new APIError("Connect to check the authoritative preview.", "offline"); const result = await request<{ allocation: ResolvedExpense }>(ledgerQuery("/preview"), { method: "POST", body: JSON.stringify(input) }); requireIdentity(user, lease); return result; }); }
export async function previewPosting(user: AuthUser, input: { ruleId: string; expectedRuleVersion: number; period: number }): Promise<{ source: RecurringPostingSource }> { return runHouseholdWork(async lease => { requireIdentity(user, lease); if (!online()) throw new APIError("Connect to inspect this recurring period.", "offline"); const result = await request<{ source: RecurringPostingSource }>(ledgerQuery("/preview"), { method: "POST", body: JSON.stringify({ kind: "rule-posting", ...input }) }); requireIdentity(user, lease); return result; }); }
export interface StatementExportInput { memberId: string; currency: Currency; from?: string; to?: string; format: "csv" | "json" }
export interface PreparedStatementExport { text: string; filename: string; mime: string; scope: StatementScope; revision: number; openingMinor: number; movementMinor: number; closingMinor: number; movementCount: number; bytes: number }
/** Returns a complete artifact only. Cancellation, stale revision and changed identity return none. */
export function prepareStatementExport(user: AuthUser, input: StatementExportInput, options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {}): Promise<PreparedStatementExport> {
  return runHouseholdWork(async lease => {
    const check = () => { requireIdentity(user, lease); if (options.signal?.aborted) throw new APIError("Export cancelled.", "cancelled"); };
    check(); if (!online()) throw new APIError("Connect to prepare a current complete statement.", "offline");
    const expectedScope: StatementScope = { memberId: input.memberId, currency: input.currency, from: input.from ?? null, to: input.to ?? null, basis: "current-effective" };
    const encoder = new TextEncoder(); const rows: StatementMovement[] = []; const chunks: string[] = []; const cursors = new Set<string>(); const entries = new Set<string>();
    let first: StatementExport | undefined; let cursor: string | undefined; let bytes = 0;
    do {
      check();
      const raw: unknown = await request(ledgerQuery("/export", { ...input, limit: 50, cursor }), undefined, { signal: options.signal }); check();
      if (!validExport(raw) || JSON.stringify(raw.scope) !== JSON.stringify(expectedScope) || raw.format !== input.format) throw new APIError("The statement response is unreadable or has a different scope. Restart export.", "invalid_response");
      const page = raw;
      if (page.requiresNarrowerRange || page.movementCount > 10000) throw new APIError("Choose a narrower date range: this statement exceeds 10,000 movements.", "export_too_large");
      if (first && (first.revision !== page.revision || first.openingMinor !== page.openingMinor || first.movementMinor !== page.movementMinor || first.closingMinor !== page.closingMinor || first.movementCount !== page.movementCount)) throw new APIError("The statement changed during preparation. Restart export.", "ledger_revision_changed");
      first ??= page;
      for (const row of page.items) { const key = JSON.stringify([row.entryId, row.version]); if (entries.has(key)) throw new APIError("Statement pages overlap. Restart export.", "invalid_response"); entries.add(key); }
      rows.push(...page.items);
      if (rows.length > 10000 || rows.length > first.movementCount) throw new APIError("Choose a narrower date range: this statement exceeds its declared movement limit.", "export_too_large");
      if (input.format === "csv") {
        const csv = page.csv!; const end = csv.indexOf("\r\n"); if (end < 0) throw new APIError("The CSV statement is unreadable.", "invalid_response");
        const chunk = chunks.length ? csv.slice(end + 2) : csv; chunks.push(chunk); bytes += encoder.encode(chunk).byteLength;
      } else bytes += page.items.reduce((sum, row) => sum + encoder.encode(JSON.stringify(row)).byteLength + 1, 0);
      if (bytes > 8388608) throw new APIError("Choose a narrower date range: this complete statement exceeds 8 MiB.", "export_too_large");
      check(); options.onProgress?.(rows.length, first.movementCount); check();
      cursor = page.nextCursor ?? undefined;
      if (cursor && cursors.has(cursor)) throw new APIError("Statement continuation repeated. Restart export.", "invalid_response");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!first || rows.length !== first.movementCount) throw new APIError("The statement is incomplete. Restart export.", "invalid_response");
    let running = BigInt(first.openingMinor);
    for (const row of rows) { running += BigInt(row.amountMinor); if (running !== BigInt(row.runningMinor)) throw new APIError("The statement does not reconcile. Restart export.", "invalid_response"); }
    if (running !== BigInt(first.closingMinor)) throw new APIError("The statement closing balance does not reconcile.", "invalid_response");
    const text = input.format === "csv" ? chunks.join("") : JSON.stringify({ scope: first.scope, revision: first.revision, openingMinor: first.openingMinor, movementMinor: first.movementMinor, closingMinor: first.closingMinor, movementCount: first.movementCount, items: rows });
    bytes = encoder.encode(text).byteLength; if (bytes > 8388608) throw new APIError("Choose a narrower date range: this complete statement exceeds 8 MiB.", "export_too_large");
    check(); return { text, filename: `statement-${input.currency}-${input.from ?? "all"}-${input.to ?? "current"}.${input.format}`, mime: input.format === "csv" ? "text/csv;charset=utf-8" : "application/json", scope: first.scope, revision: first.revision, openingMinor: first.openingMinor, movementMinor: first.movementMinor, closingMinor: first.closingMinor, movementCount: rows.length, bytes };
  });
}
function validExport(value: unknown): value is StatementExport {
  if (!object(value) || !object(value.scope) || !Array.isArray(value.items) || value.items.length > 50 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || value.nextCursor !== null && typeof value.nextCursor !== "string" || !["csv", "json"].includes(String(value.format)) || value.format === "csv" && typeof value.csv !== "string") return false;
  if (![value.openingMinor, value.movementMinor, value.closingMinor, value.movementCount].every(n => typeof n === "number" && Number.isSafeInteger(n)) || Number(value.movementCount) < 0 || BigInt(Number(value.openingMinor)) + BigInt(Number(value.movementMinor)) !== BigInt(Number(value.closingMinor))) return false;
  return value.items.every(row => object(row) && typeof row.entryId === "string" && positiveInteger(row.version) && date(row.date) && ["expense", "refund", "payment"].includes(String(row.kind)) && typeof row.description === "string" && row.currency === (value.scope as Record<string, unknown>).currency && typeof row.amountMinor === "number" && Number.isSafeInteger(row.amountMinor) && typeof row.runningMinor === "number" && Number.isSafeInteger(row.runningMinor));
}
