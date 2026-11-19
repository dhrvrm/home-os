import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import type { ExpenseInput, LedgerCommand, LedgerEntry } from "./types";
import { commandRequest, dispatchCommand, ledgerRead, prepareStatementExport, validCommandResult } from "./api";
vi.mock("@/offline/db", async (original) => { const actual = await original<typeof import("@/offline/db")>(); return { ...actual, homeOSDatabase: new actual.HomeOSDatabase(`ledger-api-${crypto.randomUUID()}`) }; });
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "a@example.com" };
const input: ExpenseInput = { kind: "expense", date: "2026-11-19", description: "Dinner", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }] } } };
const command: LedgerCommand = { action: "create", operationId: "op", entry: input };
const entry: LedgerEntry = { id: "entry", householdId: "home", version: 1, lifecycle: "effective", intent: input, payers: input.payers, shares: input.payers, createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" };
beforeEach(async () => { localStorage.clear(); setActiveMemberId(user.id); publishAccessBoundary("ready", user); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear(); vi.stubGlobal("fetch", vi.fn()); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); });
afterAll(async () => { await homeOSDatabase.delete(); vi.unstubAllGlobals(); });
describe("ledger transport", () => {
  it("rejects malformed accepted money, wrong entry kind/currency/amount, stale versions and nonconserving allocations", () => {
    expect(validCommandResult({ status: "accepted", entry }, command)).toBe(true);
    for (const patch of [{ intent: {} }, { intent: { ...input, kind: "payment" } }, { intent: { ...input, currency: "JPY" } }, { intent: { ...input, totalMinor: 1 } }, { lifecycle: "banana" }, { shares: [{ memberId: "alice", amountMinor: 99 }] }, { version: 0 }]) expect(validCommandResult({ status: "accepted", entry: { ...entry, ...patch } }, command)).toBe(false);
    expect(validCommandResult({ status: "accepted", entry }, { action: "correct", operationId: "op2", entryId: "entry", expectedVersion: 1, entry: input })).toBe(false);
  });
  it("allows authoritative whitespace normalization for comments", () => {
    expect(validCommandResult({ status: "accepted", comment: { id: "c", entryId: "entry", observedVersion: 1, authorId: "alice", text: "Dinner", acceptedAt: "2026-11-19T00:00:00Z" } }, { action: "comment", operationId: "op", entryId: "entry", expectedVersion: 1, text: " Dinner " })).toBe(true);
  });
  it("adapts all financial commands without changing their operation intent", () => {
    expect(commandRequest(command)).toEqual({ path: "/expenses", method: "POST", body: input });
    expect(commandRequest({ action: "void", operationId: "op", entryId: "entry", expectedVersion: 3 })).toEqual({ path: "/entries/entry/void", method: "POST", body: {}, version: 3 });
    expect(commandRequest({ action: "post", operationId: "op", ruleId: "rule", expectedRuleVersion: 2, period: 1, date: "2026-11-19", payers: input.payers })).toEqual({ path: "/rule-postings", method: "POST", body: { ruleId: "rule", expectedRuleVersion: 2, period: 1, date: "2026-11-19", payers: input.payers } });
    expect(commandRequest({ action: "correct", operationId: "op", entryId: "entry", expectedVersion: 3, entry: input })).toEqual({ path: "/entries/entry", method: "PUT", body: input, version: 3 });
    expect(commandRequest({ action: "restore", operationId: "op", entryId: "entry", expectedVersion: 4 })).toEqual({ path: "/entries/entry/restore", method: "POST", body: {}, version: 4 });
    const refund = { kind: "refund" as const, expenseId: "entry", date: input.date, description: "Returned", currency: input.currency, totalMinor: 10000, payers: input.payers, shares: input.payers };
    expect(commandRequest({ action: "create", operationId: "op", entry: refund })).toEqual({ path: "/refunds", method: "POST", body: refund });
    const payment = { kind: "payment" as const, date: input.date, currency: input.currency, totalMinor: 100, senderId: "alice", receiverId: "bob", method: "cash" };
    expect(commandRequest({ action: "create", operationId: "op", entry: payment })).toEqual({ path: "/payments", method: "POST", body: payment });
  });
  it("bounds per-person read copies to 20 query pages and 10 details while retaining the separate money slot", async () => {
    await homeOSDatabase.householdCache.put({ key: JSON.stringify(["home", "alice", "ledger:attempt:v1"]), memberId: "alice", householdId: "home", savedAt: new Date().toISOString(), data: { private: true } });
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: { value: 1 }, error: null })));
    const valid = (v: unknown): v is { value: number } => !!v && typeof v === "object" && "value" in v && v.value === 1;
    for (let i = 0; i < 23; i++) await ledgerRead(user, `/api/v1/ledger/entries?cursor=${i}`, valid);
    for (let i = 0; i < 13; i++) await ledgerRead(user, `/api/v1/ledger/entries/${i}`, valid, "detail");
    const rows = await homeOSDatabase.householdCache.toArray();
    expect(rows.filter(row => JSON.parse(row.key)[2].startsWith("ledger:read:query:"))).toHaveLength(20);
    expect(rows.filter(row => JSON.parse(row.key)[2].startsWith("ledger:read:detail:"))).toHaveLength(10);
    expect(rows.some(row => JSON.parse(row.key)[2] === "ledger:attempt:v1")).toBe(true);
  });
  it.each(["query", "detail"] as const)("retains the higher same-key %s revision and its original timestamp after delayed reads and offline reopening", async kind => {
    type Snapshot = { revision: number; value: string };
    const valid = (v: unknown): v is Snapshot => !!v && typeof v === "object" && "revision" in v && Number.isSafeInteger(v.revision) && "value" in v && typeof v.value === "string";
    const path = "/api/v1/ledger/entries?from=2026-11-01&to=2026-11-19&cursor=unchanged";
    let resolveOld!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const oldRead = ledgerRead(user, path, valid, kind);
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { revision: 2, value: "new" }, error: null })));
    const newer = await ledgerRead(user, path, valid, kind);
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveOld(new Response(JSON.stringify({ data: { revision: 1, value: "old" }, error: null })));
    const delayed = await oldRead;
    expect(delayed).toEqual({ data: newer.data, savedAt: newer.savedAt, cached: true });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(await ledgerRead(user, path, valid, kind)).toEqual({ data: newer.data, savedAt: newer.savedAt, cached: true });
  });
  it("assembles only a complete export at one revision and keeps the first CSV header", async () => {
    const scope = { memberId: "alice", currency: "INR" as const, from: null, to: null, basis: "current-effective" as const };
    const page = (id: string, nextCursor: string | null, csv: string, revision = 1) => ({ scope, revision, format: "csv", csv, nextCursor, items: [{ entryId: id, version: 1, date: "2026-11-19", kind: "expense", description: "Dinner", currency: "INR", amountMinor: 1, runningMinor: id === "one" ? 1 : 2 }], openingMinor: 0, movementMinor: 2, closingMinor: 2, movementCount: 2, maxMovementRows: 10000, maxBytes: 8388608, requiresNarrowerRange: false });
    const reply = (data: unknown) => new Response(JSON.stringify({ data, error: null }));
    vi.mocked(fetch).mockResolvedValueOnce(reply(page("one", "next", "header\r\none\r\n"))).mockResolvedValueOnce(reply(page("two", null, "header\r\ntwo\r\n")));
    const result = await prepareStatementExport(user, { memberId: "alice", currency: "INR", format: "csv" });
    expect(result.text).toBe("header\r\none\r\ntwo\r\n");
    expect(result.movementCount).toBe(2);
    expect(result).toMatchObject({ openingMinor: 0, movementMinor: 2, closingMinor: 2 });
    vi.mocked(fetch).mockResolvedValueOnce(reply(page("one", "next", "header\r\none\r\n"))).mockResolvedValueOnce(reply(page("two", null, "header\r\ntwo\r\n", 2)));
    await expect(prepareStatementExport(user, { memberId: "alice", currency: "INR", format: "csv" })).rejects.toThrow(/changed|restart/i);
  });
  it("refuses oversized UTF-8 exports and stale-identity preparation without creating a partial file", async () => {
    const page = { scope: { memberId: "alice", currency: "INR", from: null, to: null, basis: "current-effective" }, revision: 1, format: "csv", csv: "head\r\n" + "家".repeat(3_000_000), nextCursor: null, items: [], openingMinor: 0, movementMinor: 0, closingMinor: 0, movementCount: 0, maxMovementRows: 10000, maxBytes: 8388608, requiresNarrowerRange: false };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: page, error: null })));
    await expect(prepareStatementExport(user, { memberId: "alice", currency: "INR", format: "csv" })).rejects.toThrow(/narrower/i);
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = prepareStatementExport(user, { memberId: "alice", currency: "INR", format: "csv" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    setActiveMemberId("bob"); publishAccessBoundary("ready", { id: "bob", householdId: "home" });
    finish(new Response(JSON.stringify({ data: { ...page, csv: "head\r\n" }, error: null })));
    await expect(pending).rejects.toThrow(/access changed/i);
  });
  it("cannot cache a delayed prior-person read over the next person's real retained copy", async () => {
    let finish!: (value: Response) => void;
    const valid = (value: unknown): value is { name: string } => !!value && typeof value === "object" && "name" in value && typeof value.name === "string";
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = ledgerRead(user, "/api/v1/ledger/entries", valid);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const bob = { ...user, id: "bob" }; setActiveMemberId(bob.id); publishAccessBoundary("ready", bob);
    await homeOSDatabase.householdCache.clear();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { name: "Bob's copy" }, error: null })));
    await ledgerRead(bob, "/api/v1/ledger/entries", valid);
    finish(new Response(JSON.stringify({ data: { name: "Alice's delayed copy" }, error: null })));
    await expect(pending).rejects.toThrow(/access changed/i);
    const rows = await homeOSDatabase.householdCache.toArray(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ memberId: "bob", data: { name: "Bob's copy" } });
  });
  it("preserves authorized conflict details for explicit review and strips authority-refusal details", async () => {
    const details = { entityType: "ledger_source", current: entry };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Already posted", details } }), { status: 409 }));
    await expect(dispatchCommand(command)).rejects.toMatchObject({ status: 409, details });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "forbidden", message: "Revoked", details } }), { status: 403 }));
    await expect(dispatchCommand(command)).rejects.toMatchObject({ status: 403, details: undefined });
  });
});
