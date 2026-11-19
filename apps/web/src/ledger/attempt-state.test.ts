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
    await expect(pending).rejects.toThrow(/access changed/i);
    expect((await readAttempt(user))?.command).toEqual(newer);
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
