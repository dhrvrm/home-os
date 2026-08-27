import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HomeOSDatabase } from "./db";
import {
  applyLocalStockEvent,
  archiveLocalItem,
  createLocalItem,
  listLocalItems,
  restoreLocalItem,
  updateLocalItem,
} from "./commands";

describe("offline inventory commands", () => {
  let database: HomeOSDatabase;
  let nextId: number;
  const options = {
    householdId: "home",
    actorId: "member-1",
    deviceId: "test-device",
    now: () => new Date("2026-08-27T12:00:00.000Z"),
    newId: () => `local-${++nextId}`,
  };

  beforeEach(() => {
    nextId = 0;
    database = new HomeOSDatabase(`home-os-test-${crypto.randomUUID()}`);
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it("creates the projection and outbox operation in one transaction", async () => {
    const item = await createLocalItem(
      database,
      {
        name: "Rice",
        alternativeNames: ["चावल"],
        categories: ["Food", "Staples"],
        trackingMode: "exact",
        quantity: 5,
        minQuantity: 1,
        unit: "kg",
        location: "Pantry",
      },
      options,
    );

    expect(item).toMatchObject({
      id: "local-1",
      householdId: "home",
      name: "Rice",
      alternativeNames: ["चावल"],
      categories: ["Food", "Staples"],
      quantity: 5,
      version: 1,
      syncState: "pending",
    });
    await expect(database.items.get(item.id)).resolves.toMatchObject({ id: item.id });
    await expect(database.outbox.toArray()).resolves.toEqual([
      expect.objectContaining({
        operationId: "local-2",
        kind: "inventory.create",
        entityId: item.id,
        expectedVersion: 0,
        state: "pending",
      }),
    ]);
  });

  it("keeps multiple offline mutations ordered by local versions", async () => {
    const created = await createLocalItem(database, { name: "Soap", levelPercent: 50 }, options);
    const updated = await updateLocalItem(database, created.id, { categories: ["Cleaning", "Kitchen"] }, options);
    const consumed = await applyLocalStockEvent(database, created.id, { type: "consume" }, options);

    expect(updated).toMatchObject({ categories: ["Cleaning", "Kitchen"], version: 2 });
    expect(consumed).toMatchObject({ levelPercent: 25, stockLevel: "low", version: 3 });
    expect((await database.outbox.orderBy("createdAt").toArray()).map((operation) => [
      operation.kind,
      operation.expectedVersion,
    ])).toEqual([
      ["inventory.create", 0],
      ["inventory.update", 1],
      ["inventory.stock", 2],
    ]);
    await expect(database.stockEvents.where("itemId").equals(created.id).toArray()).resolves.toEqual([
      expect.objectContaining({ type: "consume", quantity: 25, levelPercent: 25 }),
    ]);
  });

  it("archives and restores locally without deleting history", async () => {
    const created = await createLocalItem(database, { name: "Torch" }, options);
    await applyLocalStockEvent(database, created.id, { type: "consume" }, options);
    const archived = await archiveLocalItem(database, created.id, options);
    const restored = await restoreLocalItem(database, created.id, options);

    expect(archived).toMatchObject({ archivedAt: "2026-08-27T12:00:00.000Z", version: 3 });
    expect(restored).toMatchObject({ archivedAt: null, version: 4 });
    await expect(database.stockEvents.where("itemId").equals(created.id).count()).resolves.toBe(1);
  });

  it("scopes cached projections and mutations to one household", async () => {
    const first = await createLocalItem(database, { name: "First home rice" }, options);
    await createLocalItem(database, { name: "Second home rice" }, {
      ...options,
      householdId: "second-home",
      actorId: "member-2",
      newId: (() => {
        let value = 0;
        return () => `second-${++value}`;
      })(),
    });

    await expect(listLocalItems(database, "home")).resolves.toEqual([
      expect.objectContaining({ id: first.id, name: "First home rice" }),
    ]);
    await expect(listLocalItems(database, "second-home")).resolves.toEqual([
      expect.objectContaining({ name: "Second home rice" }),
    ]);
    await expect(
      updateLocalItem(database, first.id, { name: "Cross-home edit" }, {
        ...options,
        householdId: "second-home",
        actorId: "member-2",
      }),
    ).rejects.toThrow("Inventory item not found");
  });
});
