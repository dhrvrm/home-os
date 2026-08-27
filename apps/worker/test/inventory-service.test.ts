import { beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../src/platform/context";
import { ConflictError, NotFoundError } from "../src/platform/errors";
import type {
  AuditChange,
  InventoryMutation,
  InventoryRepository,
} from "../src/inventory/repository";
import type {
  InventoryFilter,
  InventoryItem,
  StockEvent,
} from "../src/inventory/model";
import { calculateCadence, calculateForecast } from "../src/inventory/forecast";
import { InventoryService } from "../src/inventory/service";

class MemoryInventoryRepository implements InventoryRepository {
  readonly items = new Map<string, InventoryItem>();
  readonly events = new Map<string, StockEvent[]>();
  readonly mutations: Array<{ mutation: InventoryMutation; changes: AuditChange[] }> = [];

  async listItems(householdId: string, filter: InventoryFilter): Promise<InventoryItem[]> {
    return [...this.items.values()].filter((item) => {
      if (item.householdId !== householdId) return false;
      if (filter.archived === "only" && item.archivedAt === null) return false;
      if (filter.archived !== "only" && filter.archived !== "include" && item.archivedAt !== null) return false;
      if (filter.category && !item.categories.includes(filter.category)) return false;
      if (filter.stockLevel && item.stockLevel !== filter.stockLevel) return false;
      if (filter.query) {
        const query = filter.query.toLocaleLowerCase();
        const names = [item.name, ...item.alternativeNames].join(" ").toLocaleLowerCase();
        if (!names.includes(query)) return false;
      }
      return true;
    });
  }

  async getItem(householdId: string, itemId: string): Promise<InventoryItem> {
    const item = this.items.get(itemId);
    if (!item || item.householdId !== householdId) throw new NotFoundError("inventory_item", itemId);
    return structuredClone(item);
  }

  async createItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    this.items.set(item.id, structuredClone(item));
    this.mutations.push({ mutation, changes: mutation.changes });
    return structuredClone(item);
  }

  async updateItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    this.assertVersion(item.id, mutation.expectedVersion);
    this.items.set(item.id, structuredClone(item));
    this.mutations.push({ mutation, changes: mutation.changes });
    return structuredClone(item);
  }

  async setArchived(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    return this.updateItem(item, mutation);
  }

  async applyStockEvent(
    item: InventoryItem,
    event: StockEvent,
    mutation: InventoryMutation,
  ): Promise<InventoryItem> {
    this.assertVersion(item.id, mutation.expectedVersion);
    this.items.set(item.id, structuredClone(item));
    this.events.set(item.id, [...(this.events.get(item.id) ?? []), structuredClone(event)]);
    this.mutations.push({ mutation, changes: mutation.changes });
    return structuredClone(item);
  }

  async listEvents(householdId: string, itemId: string, since: string): Promise<StockEvent[]> {
    await this.getItem(householdId, itemId);
    return (this.events.get(itemId) ?? [])
      .filter((event) => event.occurredAt >= since)
      .map((event) => structuredClone(event));
  }

  private assertVersion(itemId: string, expectedVersion: number): void {
    const current = this.items.get(itemId);
    if (!current) throw new NotFoundError("inventory_item", itemId);
    if (current.version !== expectedVersion) {
      throw new ConflictError("inventory_item", itemId, expectedVersion, current.version);
    }
  }
}

const now = new Date("2026-08-27T12:00:00.000Z");
const command: CommandContext = {
  householdId: "home",
  actorId: "member-1",
  actorType: "member",
  source: "pwa",
  operationId: "operation-1",
  deviceId: "device-1",
  clientTime: "2026-08-27T11:59:00.000Z",
};

describe("InventoryService", () => {
  let repository: MemoryInventoryRepository;
  let nextId: number;
  let service: InventoryService;

  beforeEach(() => {
    repository = new MemoryInventoryRepository();
    nextId = 0;
    service = new InventoryService(repository, {
      now: () => now,
      newId: () => `generated-${++nextId}`,
    });
  });

  it("creates a simple item with normalized names, ordered categories, and safe defaults", async () => {
    const item = await service.createItem(command, {
      name: "  Dish soap  ",
      alternativeNames: [" साबुन ", "Soap", "soap", "Dish soap", ""],
      categories: [" Cleaning ", "Kitchen", "cleaning", ""],
      location: "",
      unit: "",
      trackingMode: "simple",
      quantity: 0,
      minQuantity: 0,
    });

    expect(item).toMatchObject({
      id: "generated-1",
      householdId: "home",
      name: "Dish soap",
      alternativeNames: ["साबुन", "Soap"],
      category: "Cleaning",
      categories: ["Cleaning", "Kitchen"],
      location: "Unassigned",
      unit: "item",
      trackingMode: "simple",
      stockLevel: "okay",
      levelPercent: 50,
      version: 1,
      archivedAt: null,
    });
    expect(repository.mutations[0]?.mutation).toMatchObject({ action: "inventory.item.created" });
  });

  it("defaults an omitted category to Other", async () => {
    const item = await service.createItem(command, { name: "Torch" });
    expect(item.categories).toEqual(["Other"]);
    expect(item.category).toBe("Other");
  });

  it.each([
    ["blank name", { name: "  " }, "name"],
    ["negative quantity", { name: "Rice", quantity: -1 }, "quantity"],
    ["overfull percentage", { name: "Rice", levelPercent: 101 }, "levelPercent"],
    ["too many aliases", { name: "Rice", alternativeNames: Array.from({ length: 9 }, (_, i) => `a${i}`) }, "alternativeNames"],
    ["too many categories", { name: "Rice", categories: Array.from({ length: 10 }, (_, i) => `c${i}`) }, "categories"],
  ])("rejects %s", async (_label, input, field) => {
    await expect(service.createItem(command, input)).rejects.toMatchObject({ field });
  });

  it("updates metadata without changing stock and records field deltas", async () => {
    const created = await service.createItem(command, {
      name: "Rice",
      alternativeNames: ["चावल"],
      categories: ["Food"],
      trackingMode: "exact",
      quantity: 4,
      minQuantity: 1,
      unit: "kg",
    });

    const updated = await service.updateItem(
      { ...command, operationId: "operation-2", expectedVersion: 1 },
      created.id,
      {
        name: "Basmati rice",
        categories: ["Food", "Staples"],
        location: "Kitchen shelf",
        minQuantity: 6,
      },
    );

    expect(updated).toMatchObject({
      name: "Basmati rice",
      alternativeNames: ["चावल"],
      categories: ["Food", "Staples"],
      quantity: 4,
      stockLevel: "okay",
      version: 2,
    });
    expect(repository.mutations.at(-1)?.changes.map((change) => change.path)).toEqual([
      "/name",
      "/categories",
      "/location",
      "/minQuantity",
    ]);
  });

  it("consumes and restocks a simple item in percentage points", async () => {
    const item = await service.createItem(command, { name: "Soap", levelPercent: 50 });
    const consumed = await service.applyStockEvent(
      { ...command, operationId: "operation-2", expectedVersion: 1 },
      item.id,
      { type: "consume" },
    );
    const restocked = await service.applyStockEvent(
      { ...command, operationId: "operation-3", expectedVersion: 2 },
      item.id,
      { type: "restock" },
    );

    expect(consumed).toMatchObject({ levelPercent: 25, stockLevel: "low", version: 2 });
    expect(restocked).toMatchObject({ levelPercent: 100, stockLevel: "full", version: 3 });
    expect(repository.events.get(item.id)?.map((event) => event.quantity)).toEqual([25, 0]);
  });

  it("supports explicit simple consumption and mark-level zero", async () => {
    const item = await service.createItem(command, { name: "Soap", levelPercent: 90 });
    const consumed = await service.applyStockEvent(
      { ...command, operationId: "operation-2", expectedVersion: 1 },
      item.id,
      { type: "consume", quantity: 15 },
    );
    const empty = await service.applyStockEvent(
      { ...command, operationId: "operation-3", expectedVersion: 2 },
      item.id,
      { type: "mark_level", levelPercent: 0 },
    );

    expect(consumed).toMatchObject({ levelPercent: 75, stockLevel: "okay" });
    expect(empty).toMatchObject({ levelPercent: 0, stockLevel: "out" });
  });

  it("records actual exact consumption and derives low/out states", async () => {
    const item = await service.createItem(command, {
      name: "Milk",
      trackingMode: "exact",
      quantity: 3,
      minQuantity: 1,
      unit: "bottle",
    });
    const low = await service.applyStockEvent(
      { ...command, operationId: "operation-2", expectedVersion: 1 },
      item.id,
      { type: "consume", quantity: 2 },
    );
    const out = await service.applyStockEvent(
      { ...command, operationId: "operation-3", expectedVersion: 2 },
      item.id,
      { type: "consume", quantity: 8, note: "Used for guests" },
    );

    expect(low).toMatchObject({ quantity: 1, stockLevel: "low" });
    expect(out).toMatchObject({ quantity: 0, stockLevel: "out" });
    expect(repository.events.get(item.id)?.at(-1)).toMatchObject({ quantity: 1, note: "Used for guests" });
  });

  it("archives and restores without losing stock history", async () => {
    const item = await service.createItem(command, { name: "Soap" });
    await service.applyStockEvent(
      { ...command, operationId: "operation-2", expectedVersion: 1 },
      item.id,
      { type: "consume" },
    );
    const archived = await service.archiveItem(
      { ...command, operationId: "operation-3", expectedVersion: 2 },
      item.id,
    );
    const restored = await service.restoreItem(
      { ...command, operationId: "operation-4", expectedVersion: 3 },
      item.id,
    );

    expect(archived.archivedAt).toBe(now.toISOString());
    expect(restored).toMatchObject({ archivedAt: null, version: 4 });
    expect(await service.listEvents("home", item.id)).toHaveLength(1);
  });

  it("rejects a stale expected version", async () => {
    const item = await service.createItem(command, { name: "Rice" });
    await expect(
      service.updateItem({ ...command, operationId: "operation-2", expectedVersion: 0 }, item.id, { name: "Old" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("inventory forecasting", () => {
  it("uses recent exact consumption and increases confidence with samples", () => {
    const item = {
      trackingMode: "exact",
      quantity: 6,
    } as InventoryItem;
    const events: StockEvent[] = [
      { type: "consume", quantity: 2, occurredAt: "2026-08-23T12:00:00.000Z" } as StockEvent,
      { type: "consume", quantity: 2, occurredAt: "2026-08-25T12:00:00.000Z" } as StockEvent,
    ];

    expect(calculateForecast(item, events, now)).toEqual({
      dailyUsage: 1,
      daysRemaining: 6,
      confidence: "low",
    });
  });

  it("sorts past consumption events for cadence and ignores future/restock events", () => {
    const events: StockEvent[] = [
      { type: "consume", occurredAt: "2026-08-25T12:00:00.000Z" } as StockEvent,
      { type: "restock", occurredAt: "2026-08-24T12:00:00.000Z" } as StockEvent,
      { type: "consume", occurredAt: "2026-08-28T12:00:00.000Z" } as StockEvent,
      { type: "consume", occurredAt: "2026-08-17T12:00:00.000Z" } as StockEvent,
      { type: "consume", occurredAt: "2026-08-21T12:00:00.000Z" } as StockEvent,
    ];

    expect(calculateCadence(events, now)).toEqual({
      averageIntervalDays: 4,
      eventsPerWeek: 1.8,
      lastConsumedAt: "2026-08-25T12:00:00.000Z",
      confidence: "low",
    });
  });
});
