import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId, lockHouseholdWork } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import type { LedgerCommand } from "./types";
import { checkAttempt, readAttempt, replayAttempt, submitAttempt } from "./attempt-state";
vi.mock("@/offline/db", async (original) => { const actual = await original<typeof import("@/offline/db")>(); return { ...actual, homeOSDatabase: new actual.HomeOSDatabase(`money-attempt-${crypto.randomUUID()}`) }; });
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "a@example.com" };
const command = (id = crypto.randomUUID()): LedgerCommand => ({ operationId: id, action: "comment", entryId: "entry", expectedVersion: 1, text: "Dinner" });
function admit(person = user) { setActiveMemberId(person.id); publishAccessBoundary("ready", person); resumeHouseholdWork(); }
function response(data: unknown, status = 200) { return new Response(JSON.stringify({ data, error: null }), { status }); }
const accepted = { status: "accepted", comment: { id: "comment", entryId: "entry", observedVersion: 1, authorId: "alice", text: "Dinner", acceptedAt: "2026-11-19T00:00:00Z" } };
beforeEach(async () => { localStorage.clear(); admit(); await homeOSDatabase.householdCache.clear(); vi.stubGlobal("fetch", vi.fn()); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); });
afterAll(async () => { await homeOSDatabase.delete(); vi.unstubAllGlobals(); });
describe("durable financial attempts with real IndexedDB and access leases", () => {
  it("retains before dispatch and replays the exact frozen comment after response loss", async () => {
    const intent = command();
    vi.mocked(fetch).mockImplementationOnce(async () => { expect((await readAttempt(user))?.command).toEqual(intent); throw new TypeError("lost"); });
    expect((await submitAttempt(user, intent)).kind).toBe("unknown");
    expect((await readAttempt(user))?.command).toEqual(intent);
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: "unknown" }));
    expect((await checkAttempt(user)).kind).toBe("unknown");
    expect(await readAttempt(user)).not.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(response(accepted, 201));
    expect((await replayAttempt(user)).kind).toBe("accepted");
    expect(vi.mocked(fetch).mock.calls[2]?.[1]).toMatchObject({ headers: expect.objectContaining({ "X-Operation-ID": intent.operationId, "If-Match": "1" }), body: JSON.stringify({ text: "Dinner" }) });
    expect(await readAttempt(user)).toBeNull();
  });
  it("acquires one slot transactionally across simultaneous commands", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("lost"));
    const results = await Promise.all([submitAttempt(user, command()), submitAttempt(user, command())]);
    expect(results.map(r => r.kind).sort()).toEqual(["unknown", "unknown"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await homeOSDatabase.householdCache.count()).toBe(1);
  });
  it("never dispatches when durable retention fails", async () => {
    vi.spyOn(homeOSDatabase.householdCache, "add").mockRejectedValueOnce(new Error("quota"));
    await expect(submitAttempt(user, command())).rejects.toThrow(/prepare|quota/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("locks 403 after possible acceptance, and same-person revalidation preserves recovery", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "forbidden", message: "Revoked" } }), { status: 403 }));
    expect((await submitAttempt(user, command())).kind).toBe("locked");
    lockHouseholdWork(); admit();
    expect((await readAttempt(user))?.phase).toBe("locked");
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: "accepted", entryId: "entry", version: 1, action: "comment", commentId: "comment" }));
    expect((await checkAttempt(user)).kind).toBe("accepted");
  });
  it("retains unknown after 5xx, malformed success and any later validation refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("broken", { status: 503 }));
    expect((await submitAttempt(user, command())).kind).toBe("unknown");
    vi.mocked(fetch).mockResolvedValueOnce(response({ nonsense: true }));
    expect((await replayAttempt(user)).kind).toBe("unknown");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "invalid_request", message: "Fix comment" } }), { status: 400 }));
    expect((await replayAttempt(user)).kind).toBe("unknown");
    expect(await readAttempt(user)).not.toBeNull();
  });
  it.each([{}, [], null, { data: null, error: {} }, { data: null, error: { code: 1, message: "Refused" } }, { data: null, error: { code: "conflict", message: 1 } }, { data: null, error: { code: "conflict", message: "Refused", field: 1 } }, { data: {}, error: { code: "conflict", message: "Refused" } }])("retains an actual first-send slot for unreadable 409 JSON %j", async body => {
    const intent = command();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 409 }));
    expect((await submitAttempt(user, intent)).kind).toBe("unknown");
    expect(await readAttempt(user)).toMatchObject({ command: intent, phase: "unknown", mayHaveOtherRequest: true });
  });
  it.each([401, 403, 408, 429])("retains malformed JSON at HTTP %i with the proper authority lock", async status => {
    const intent = command();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("null", { status }));
    expect((await submitAttempt(user, intent)).kind).toBe([401, 403].includes(status) ? "locked" : "unknown");
    expect((await readAttempt(user))?.command).toEqual(intent);
  });
  it("freezes a first send when the purported accepted result is corrupt", async () => {
    const intent = command();
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...accepted, comment: { ...accepted.comment, observedVersion: 99 } }, 201));
    expect((await submitAttempt(user, intent)).kind).toBe("unknown");
    expect((await readAttempt(user))?.command).toEqual(intent);
  });
  it("cannot clear or populate the next person's slot from a delayed previous-person response", async () => {
    let finish!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = submitAttempt(user, command());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const bob = { ...user, id: "bob" }; lockHouseholdWork();
    await homeOSDatabase.householdCache.clear(); admit(bob);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost"));
    const bobCommand = command(); await submitAttempt(bob, bobCommand);
    finish(response(accepted, 201));
    await expect(pending).rejects.toThrow(/access changed/i);
    expect((await readAttempt(bob))?.command).toEqual(bobCommand);
    expect(await homeOSDatabase.householdCache.count()).toBe(1);
  });
  it("cannot clear a newer same-person attempt after status resolved an older in-flight save", async () => {
    let finish!: (r: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = submitAttempt(user, command());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: "accepted", entryId: "entry", version: 1, action: "comment", commentId: "comment" }));
    expect((await checkAttempt(user)).kind).toBe("accepted");
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost"));
    const newer = command(); await submitAttempt(user, newer);
    finish(response(accepted, 201));
    await expect(pending).resolves.toMatchObject({ kind: "accepted", currentAttempt: { command: newer } });
    expect((await readAttempt(user))?.command).toEqual(newer);
  });
  it("returns both concurrent accepted statuses after the first recovery clears the shared slot", async () => {
    const intent = command(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, intent);
    const finishes: ((value: Response) => void)[] = [];
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    const first = checkAttempt(user); const second = checkAttempt(user);
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    const reference = { status: "accepted", entryId: "entry", version: 1, action: "comment", commentId: "comment" };
    finishes[0](response(reference)); await expect(first).resolves.toMatchObject({ kind: "accepted", operationId: intent.operationId, currentAttempt: null });
    finishes[1](response(reference)); await expect(second).resolves.toMatchObject({ kind: "accepted", operationId: intent.operationId, currentAttempt: null });
    expect(await readAttempt(user)).toBeNull();
  });
  it("does not send a superseded replay or recreate its missing slot", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, command());
    const row = await homeOSDatabase.householdCache.toCollection().first();
    await homeOSDatabase.householdCache.clear();
    vi.spyOn(homeOSDatabase.householdCache, "get").mockResolvedValueOnce(row);
    await expect(replayAttempt(user)).resolves.toMatchObject({ kind: "superseded", attempt: null });
    expect(fetch).toHaveBeenCalledTimes(1); expect(await readAttempt(user)).toBeNull();
  });
  it.each(["unknown", "refused"])("cannot rewrite or mark a newer slot after an old %s response", async outcome => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = submitAttempt(user, command()); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: "accepted", entryId: "entry", version: 1, action: "comment", commentId: "comment" })); await checkAttempt(user);
    const newer = command(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, newer);
    const before = await homeOSDatabase.householdCache.toArray();
    finish(outcome === "refused" ? new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Refused" } }), { status: 409 }) : response({ nonsense: true }));
    await expect(old).resolves.toMatchObject({ kind: "superseded", attempt: { command: newer } });
    expect(await homeOSDatabase.householdCache.toArray()).toEqual(before);
  });
  it("does not mark or send a replay when its loaded slot has been replaced", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, command());
    const oldRow = await homeOSDatabase.householdCache.toCollection().first();
    await homeOSDatabase.householdCache.clear();
    const newer = command(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, newer);
    const before = await homeOSDatabase.householdCache.toArray();
    vi.spyOn(homeOSDatabase.householdCache, "get").mockResolvedValueOnce(oldRow);
    await expect(replayAttempt(user)).resolves.toMatchObject({ kind: "superseded", attempt: { command: newer } });
    expect(fetch).toHaveBeenCalledTimes(2); expect(await homeOSDatabase.householdCache.toArray()).toEqual(before);
  });
  it("persists Viewer recovery locking without dispatch and retains 401 even when the body is unreadable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, command());
    expect((await replayAttempt({ ...user, role: "viewer" })).kind).toBe("locked");
    expect((await readAttempt(user))?.phase).toBe("locked"); expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("broken", { status: 401 }));
    expect((await replayAttempt(user)).kind).toBe("locked");
    expect((await readAttempt(user))?.phase).toBe("locked");
  });
  it("does not clear frozen intent for a malformed or mismatched accepted reference", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); const intent = command(); await submitAttempt(user, intent);
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: "accepted", entryId: "different", version: 1, action: "comment", commentId: "comment" }));
    expect((await checkAttempt(user)).kind).toBe("unknown"); expect((await readAttempt(user))?.command).toEqual(intent);
  });
  it("permits editing after an ordinary first-send 400 or 409 but never after uncertainty/replay", async () => {
    const refusal = (status: number) => new Response(JSON.stringify({ data: null, error: { code: status === 400 ? "invalid_request" : "conflict", message: "Review the input" } }), { status });
    for (const status of [400, 409]) {
      vi.mocked(fetch).mockResolvedValueOnce(refusal(status));
      expect((await submitAttempt(user, command())).kind).toBe("refused"); expect(await readAttempt(user)).toBeNull();
      const intent = command(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await submitAttempt(user, intent);
      vi.mocked(fetch).mockResolvedValueOnce(refusal(status));
      expect((await replayAttempt(user)).kind).toBe("unknown"); expect((await readAttempt(user))?.command).toEqual(intent);
      await homeOSDatabase.householdCache.clear();
    }
  });
  it("atomically preserves another tab's replay marker against a delayed first-send refusal", async () => {
    let firstFinish!: (value: Response) => void; let replayFinish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { firstFinish = resolve; }));
    const intent = command(); const first = submitAttempt(user, intent);
    await vi.waitFor(() => expect(firstFinish).toBeTypeOf("function"));
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { replayFinish = resolve; }));
    const replay = replayAttempt(user);
    await vi.waitFor(() => expect(replayFinish).toBeTypeOf("function"));
    expect((await readAttempt(user))?.mayHaveOtherRequest).toBe(true);
    firstFinish(new Response(JSON.stringify({ data: null, error: { code: "invalid_request", message: "Initial refused" } }), { status: 400 }));
    expect((await first).kind).toBe("unknown"); expect((await readAttempt(user))?.mayHaveOtherRequest).toBe(true);
    replayFinish(new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Replay refused" } }), { status: 409 }));
    expect((await replay).kind).toBe("unknown"); expect((await readAttempt(user))?.command).toEqual(intent);
  });
});
