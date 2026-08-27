import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeOSDatabase } from "./db";
import { createLocalItem } from "./commands";
import { syncInventory } from "./sync";

describe("inventory sync client", () => {
  let database: HomeOSDatabase;

  beforeEach(() => {
    database = new HomeOSDatabase(`home-os-sync-test-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    database.close();
    await database.delete();
    vi.restoreAllMocks();
  });

  it("sends pending operations and reconciles authoritative projections", async () => {
    const item = await createLocalItem(database, { name: "Soap", levelPercent: 50 }, {
      householdId: "home",
      actorId: "member-1",
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

    const result = await syncInventory(database, { householdId: "home", fetcher });

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
      actorId: "member-1",
      deviceId: "test-device",
      newId: (() => {
        let value = 0;
        return () => `failure-${++value}`;
      })(),
    });
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));

    await expect(syncInventory(database, { householdId: "home", fetcher })).rejects.toThrow("offline");
    await expect(database.outbox.toArray()).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("sends and reconciles only the selected household outbox", async () => {
    const makeIds = (prefix: string) => {
      let value = 0;
      return () => `${prefix}-${++value}`;
    };
    const first = await createLocalItem(database, { name: "First home item" }, {
      householdId: "first-home",
      actorId: "first-member",
      deviceId: "test-device",
      newId: makeIds("first"),
    });
    await createLocalItem(database, { name: "Second home item" }, {
      householdId: "second-home",
      actorId: "second-member",
      deviceId: "test-device",
      newId: makeIds("second"),
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        results: [{ operationId: "first-2", status: "accepted" }],
        items: [{ ...first, householdId: "first-home", syncState: undefined }],
        events: [],
        activity: [],
        cursor: 4,
      },
      error: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await syncInventory(database, { householdId: "first-home", fetcher });

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).operations).toEqual([
      expect.objectContaining({ operationId: "first-2", householdId: "first-home" }),
    ]);
    await expect(database.outbox.where("householdId").equals("second-home").toArray()).resolves.toEqual([
      expect.objectContaining({ operationId: "second-2", state: "pending" }),
    ]);
  });
});
