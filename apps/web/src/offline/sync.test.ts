import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeOSDatabase } from "./db";
import { createLocalItem } from "./commands";
import { syncInventory } from "./sync";
import { lockHouseholdWork, publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";

describe("inventory sync client", () => {
  let database: HomeOSDatabase;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T12:01:00.000Z"));
    database = new HomeOSDatabase(`home-os-sync-test-${crypto.randomUUID()}`);
    localStorage.clear();
    resumeHouseholdWork();
    setActiveMemberId(null);
  });

  afterEach(async () => {
    database.close();
    await database.delete();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resumeHouseholdWork();
    localStorage.clear();
  });

  it("sends pending operations and reconciles authoritative projections", async () => {
    const item = await createLocalItem(database, { name: "Soap", levelPercent: 50 }, {
      householdId: "home",
      deviceId: "test-device",
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      newId: (() => {
        let value = 0;
        return () => `sync-local-${++value}`;
      })(),
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            results: [{ operationId: "sync-local-2", status: "accepted" }],
            items: [{ ...item, version: 1, levelPercent: 50, syncState: undefined }],
            events: [],
            activity: [{
              id: "audit-1",
              sequence: 1,
              householdId: "home",
              entityType: "inventory_item",
              entityId: item.id,
              action: "inventory.item.created",
              actorId: "local-owner",
              actorType: "member",
              source: "pwa",
              deviceId: "test-device",
              operationId: "sync-local-2",
              clientTime: "2026-08-27T12:00:00.000Z",
              serverTime: "2026-08-27T12:00:01.000Z",
              changes: [],
              mcpClientId: null,
              mcpTool: null,
            }],
            cursor: 1,
          },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await syncInventory(database, { fetcher });

    expect(result).toEqual({ accepted: 1, conflicts: 0, cursor: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      cursor: 0,
      operations: [{ operationId: "sync-local-2", kind: "inventory.create" }],
    });
    await expect(database.outbox.count()).resolves.toBe(0);
    await expect(database.items.get(item.id)).resolves.toMatchObject({ syncState: "synced", version: 1 });
    await expect(database.activity.get("audit-1")).resolves.toMatchObject({ sequence: 1 });
    await expect(database.syncState.get("home")).resolves.toMatchObject({ cursor: 1 });
  });

  it("returns sending operations to pending after a network failure", async () => {
    await createLocalItem(database, { name: "Soap" }, {
      householdId: "home",
      deviceId: "test-device",
      newId: (() => {
        let value = 0;
        return () => `failure-${++value}`;
      })(),
    });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));

    await expect(syncInventory(database, { fetcher })).rejects.toThrow("offline");
    await expect(database.outbox.toArray()).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("does not broadcast an expired grant from an old in-flight sync after reauthentication", async () => {
    await createLocalItem(database, { name: "Keep queued soap" });
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const expired = vi.fn();
    window.addEventListener("home-os:session-expired", expired);
    try {
      const result = syncInventory(database, { fetcher }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      publishAccessBoundary("ready", { id: "alice", householdId: "home" });
      finish(new Response(JSON.stringify({ data: null, error: { code: "unauthorized", message: "Old session expired" } }), { status: 401 }));
      expect(await result).toMatchObject({ code: "unauthorized" });
      expect(expired).not.toHaveBeenCalled();
      expect((await database.outbox.toArray())[0]?.state).toBe("pending");
    } finally { window.removeEventListener("home-os:session-expired", expired); }
  });

  it.each([
    [401, JSON.stringify({ data: null, error: { code: "unauthorized", message: "Sign in again" } }), "unauthorized"],
    [200, "not json", "invalid_response"],
    [409, JSON.stringify({ data: null, error: { code: "session_changed", message: "Member changed" } }), "session_changed"],
  ])("keeps operations retryable after HTTP%s or an unreadable response", async (status, body, code) => {
    await createLocalItem(database, { name: "Queued soap" });
    const expired = vi.fn();
    window.addEventListener("home-os:session-expired", expired);
    try {
      const fetcher = vi.fn().mockResolvedValue(new Response(body, { status }));
      await expect(syncInventory(database, { fetcher })).rejects.toMatchObject({ code });
      expect((await database.outbox.toArray())[0]?.state).toBe("pending");
      expect((await database.items.toArray())[0]?.name).toBe("Queued soap");
      expect(expired).toHaveBeenCalledTimes(status === 401 || code === "session_changed" ? 1 : 0);
    } finally { window.removeEventListener("home-os:session-expired", expired); }
  });

  it("rejects a late sync response after access changes without replacing saved work", async () => {
    const item = await createLocalItem(database, { name: "Original soap" });
    let finish!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const task = syncInventory(database, { fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    lockHouseholdWork();
    finish(new Response(JSON.stringify({ data: { results: [], items: [{ ...item, name: "Late replacement" }], events: [], activity: [], cursor: 0 }, error: null }), { status: 200 }));
    await expect(task).rejects.toThrow("access changed");
    expect((await database.items.get(item.id))?.name).toBe("Original soap");
    expect((await database.outbox.toArray())[0]?.state).toBe("pending");
  });

  it("sends the admitted member with sync to reject a cookie changed in another tab", async () => {
    setActiveMemberId("alice");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { results: [], items: [], events: [], activity: [], cursor: 0 }, error: null }), { status: 200 }));
    await syncInventory(database, { fetcher });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-HomeOS-Member": "alice" });
  });

  it("keeps recent activity and removes entries older than the retention window", async () => {
    await database.activity.bulkPut([
      ["recent", "2026-08-27T12:00:00.000Z"], ["old", "2026-01-01T00:00:00.000Z"],
    ].map(([id, serverTime], index) => ({
      id, serverTime, sequence: index + 1, householdId: "home", entityType: "inventory_item", entityId: "soap",
      action: "inventory.item.updated", actorId: "alice", actorType: "member" as const, source: "pwa" as const,
      deviceId: null, operationId: `activity-${id}`, clientTime: null, changes: [], mcpClientId: null, mcpTool: null,
    })));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { results: [], items: [], events: [], activity: [], cursor: 0 }, error: null }), { status: 200 }));
    await syncInventory(database, { fetcher });
    expect(await database.activity.get("old")).toBeUndefined();
    expect(await database.activity.get("recent")).toMatchObject({ id: "recent" });
  });
});
