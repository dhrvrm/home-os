import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function sync(body: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request("https://home-os.test/api/v1/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-ID": "offline-test" },
      body: JSON.stringify(body),
    }),
  );
}

describe("offline synchronization", () => {
  it("applies ordered operations, replays safely, and returns authoritative projections", async () => {
    const itemId = "offline-rice";
    const operations = [
      {
        operationId: "sync-create-rice",
        householdId: "home",
        deviceId: "offline-test",
        kind: "inventory.create",
        entityId: itemId,
        expectedVersion: 0,
        clientTime: "2026-08-27T08:00:00.000Z",
        payload: {
          name: "Rice",
          alternativeNames: ["चावल"],
          categories: ["Food", "Staples"],
          trackingMode: "exact",
          quantity: 5,
          minQuantity: 1,
          unit: "kg",
        },
      },
      {
        operationId: "sync-consume-rice",
        householdId: "home",
        deviceId: "offline-test",
        kind: "inventory.stock",
        entityId: itemId,
        expectedVersion: 1,
        clientTime: "2026-08-27T08:01:00.000Z",
        payload: { type: "consume", quantity: 1.5, note: "Lunch" },
      },
    ];

    const first = await sync({ cursor: 0, operations });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      data: {
        results: Array<{ operationId: string; status: string }>;
        items: Array<{ id: string; quantity: number; version: number }>;
        events: Array<{ itemId: string; quantity: number }>;
        activity: Array<{ sequence: number; operationId: string }>;
        cursor: number;
      };
    }>();
    expect(firstBody.data.results).toEqual([
      { operationId: "sync-create-rice", status: "accepted" },
      { operationId: "sync-consume-rice", status: "accepted" },
    ]);
    expect(firstBody.data.items).toContainEqual(expect.objectContaining({ id: itemId, quantity: 3.5, version: 2 }));
    expect(firstBody.data.events).toContainEqual(expect.objectContaining({ itemId, quantity: 1.5 }));
    expect(firstBody.data.activity.map((event) => event.operationId)).toEqual([
      "sync-create-rice",
      "sync-consume-rice",
    ]);
    expect(firstBody.data.cursor).toBeGreaterThan(0);

    const replay = await sync({ cursor: firstBody.data.cursor, operations });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json<typeof firstBody>();
    expect(replayBody.data.results.every((result) => result.status === "accepted")).toBe(true);
    expect(replayBody.data.items).toContainEqual(expect.objectContaining({ id: itemId, quantity: 3.5, version: 2 }));
    expect(replayBody.data.activity).toEqual([]);
  });

  it("returns conflicts without overwriting authoritative state", async () => {
    const itemId = "offline-soap";
    await sync({
      cursor: 0,
      operations: [
        {
          operationId: "sync-create-soap",
          householdId: "home",
          deviceId: "offline-test",
          kind: "inventory.create",
          entityId: itemId,
          expectedVersion: 0,
          clientTime: "2026-08-27T08:00:00.000Z",
          payload: { name: "Soap", levelPercent: 50 },
        },
      ],
    });

    const response = await sync({
      cursor: 0,
      operations: [
        {
          operationId: "sync-stale-soap",
          householdId: "home",
          deviceId: "offline-test",
          kind: "inventory.update",
          entityId: itemId,
          expectedVersion: 8,
          clientTime: "2026-08-27T08:02:00.000Z",
          payload: { name: "Wrong" },
        },
      ],
    });
    const body = await response.json<{
      data: {
        results: Array<{ status: string; error: { code: string }; item: { name: string; version: number } }>;
      };
    }>();
    expect(body.data.results[0]).toMatchObject({
      status: "conflict",
      error: { code: "conflict" },
      item: { name: "Soap", version: 1 },
    });
  });

  it("rejects batches larger than fifty operations", async () => {
    const response = await sync({
      cursor: 0,
      operations: Array.from({ length: 51 }, (_, index) => ({
        operationId: `too-many-${index}`,
        householdId: "home",
        deviceId: "offline-test",
        kind: "inventory.create",
        entityId: `item-${index}`,
        expectedVersion: 0,
        clientTime: "2026-08-27T08:00:00.000Z",
        payload: { name: `Item ${index}` },
      })),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ data: null, error: { code: "invalid_request" } });
  });
});
