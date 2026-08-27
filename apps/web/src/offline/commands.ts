import type { ApplyEventInput, CreateItemInput, InventoryItem, UpdateItemInput } from "@/lib/inventory";
import type { HomeOSDatabase } from "./db";
import type { OutboxOperation, OutboxOperationKind, StoredInventoryItem, StoredStockEvent } from "./schema";

export interface LocalCommandOptions {
  householdId: string;
  actorId: string;
  deviceId?: string;
  now?: () => Date;
  newId?: () => string;
}

export async function createLocalItem(
  database: HomeOSDatabase,
  input: CreateItemInput,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  const now = commandNow(options);
  const id = commandId(options);
  const categories = normalizeList(input.categories?.length ? input.categories : input.category ? [input.category] : ["Other"]);
  const trackingMode = input.trackingMode ?? "simple";
  const quantity = Math.max(0, input.quantity ?? 0);
  const minQuantity = Math.max(0, input.minQuantity ?? 0);
  const levelPercent = trackingMode === "simple" ? clamp(input.levelPercent ?? 50, 0, 100) : 0;
  const item: StoredInventoryItem = {
    id,
    householdId: options.householdId,
    name: input.name.trim(),
    alternativeNames: normalizeList(input.alternativeNames ?? [], input.name),
    category: categories[0] ?? "Other",
    categories: categories.length ? categories : ["Other"],
    location: input.location?.trim() || "Unassigned",
    unit: input.unit?.trim() || "item",
    trackingMode,
    quantity,
    stockLevel: trackingMode === "exact" ? exactLevel(quantity, minQuantity) : simpleLevel(levelPercent),
    levelPercent,
    minQuantity,
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    syncState: "pending",
  };

  await database.transaction("rw", [database.items, database.outbox], async () => {
    await database.items.add(item);
    await database.outbox.add(
      await outboxOperation(database, options, "inventory.create", item.id, 0, {
        name: item.name,
        alternativeNames: item.alternativeNames,
        categories: item.categories,
        location: item.location,
        unit: item.unit,
        trackingMode: item.trackingMode,
        quantity: item.quantity,
        levelPercent: item.levelPercent,
        minQuantity: item.minQuantity,
      }),
    );
  });
  return item;
}

export async function updateLocalItem(
  database: HomeOSDatabase,
  itemId: string,
  input: UpdateItemInput,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  return database.transaction("rw", [database.items, database.outbox], async () => {
    const current = await requiredItem(database, itemId, options.householdId);
    const next: StoredInventoryItem = {
      ...current,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.location !== undefined ? { location: input.location.trim() || "Unassigned" } : {}),
      ...(input.unit !== undefined ? { unit: input.unit.trim() || "item" } : {}),
      ...(input.minQuantity !== undefined ? { minQuantity: Math.max(0, input.minQuantity) } : {}),
      updatedAt: commandNow(options),
      version: current.version + 1,
      syncState: "pending",
    };
    if (input.alternativeNames !== undefined) {
      next.alternativeNames = normalizeList(input.alternativeNames, next.name);
    } else if (input.name !== undefined) {
      next.alternativeNames = normalizeList(next.alternativeNames, next.name);
    }
    if (input.categories !== undefined) {
      next.categories = normalizeList(input.categories);
      next.category = next.categories[0] ?? "Other";
    }
    await database.items.put(next);
    await database.outbox.add(
      await outboxOperation(database, options, "inventory.update", itemId, current.version, input),
    );
    return next;
  });
}

export async function applyLocalStockEvent(
  database: HomeOSDatabase,
  itemId: string,
  input: ApplyEventInput,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  return database.transaction("rw", [database.items, database.stockEvents, database.outbox], async () => {
    const current = await requiredItem(database, itemId, options.householdId);
    const next = { ...current, updatedAt: commandNow(options), version: current.version + 1, syncState: "pending" as const };
    let quantity = input.quantity ?? 0;
    if (input.type === "consume") {
      if (current.trackingMode === "exact") {
        if (quantity <= 0) throw new Error("Enter a quantity greater than zero.");
        quantity = Math.min(quantity, current.quantity);
        next.quantity = current.quantity - quantity;
        next.stockLevel = exactLevel(next.quantity, current.minQuantity);
      } else {
        if (quantity === 0) quantity = 25;
        next.levelPercent = Math.max(0, current.levelPercent - quantity);
        next.stockLevel = simpleLevel(next.levelPercent);
      }
    } else if (input.type === "restock") {
      if (current.trackingMode === "exact") {
        if (quantity <= 0) throw new Error("Enter a quantity greater than zero.");
        next.quantity = current.quantity + quantity;
        next.stockLevel = exactLevel(next.quantity, current.minQuantity);
      } else {
        next.levelPercent = 100;
        next.stockLevel = "full";
      }
    } else if (current.trackingMode === "simple") {
      next.levelPercent = clamp(input.levelPercent ?? 0, 0, 100);
      next.stockLevel = simpleLevel(next.levelPercent);
    } else {
      next.stockLevel = input.stockLevel ?? current.stockLevel;
      if (next.stockLevel === "out") next.quantity = 0;
    }
    const occurredAt = commandNow(options);
    const event: StoredStockEvent = {
      id: commandId(options),
      householdId: current.householdId,
      itemId,
      type: input.type,
      quantity,
      stockLevel: next.stockLevel,
      levelPercent: next.levelPercent,
      note: input.note?.trim() || "",
      actorId: options.actorId,
      occurredAt,
      createdAt: occurredAt,
    };
    await database.items.put(next);
    await database.stockEvents.add(event);
    await database.outbox.add(
      await outboxOperation(database, options, "inventory.stock", itemId, current.version, {
        ...input,
        id: event.id,
        quantity,
      }),
    );
    return next;
  });
}

export async function archiveLocalItem(
  database: HomeOSDatabase,
  itemId: string,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  return setLocalArchive(database, itemId, true, options);
}

export async function restoreLocalItem(
  database: HomeOSDatabase,
  itemId: string,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  return setLocalArchive(database, itemId, false, options);
}

export async function listLocalItems(
  database: HomeOSDatabase,
  householdId: string,
  archived = false,
): Promise<StoredInventoryItem[]> {
  const items = await database.items.where("householdId").equals(householdId).toArray();
  return items
    .filter((item) => (archived ? item.archivedAt !== null : item.archivedAt === null))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function setLocalArchive(
  database: HomeOSDatabase,
  itemId: string,
  archived: boolean,
  options: LocalCommandOptions,
): Promise<StoredInventoryItem> {
  return database.transaction("rw", [database.items, database.outbox], async () => {
    const current = await requiredItem(database, itemId, options.householdId);
    const next: StoredInventoryItem = {
      ...current,
      archivedAt: archived ? commandNow(options) : null,
      updatedAt: commandNow(options),
      version: current.version + 1,
      syncState: "pending",
    };
    await database.items.put(next);
    await database.outbox.add(
      await outboxOperation(
        database,
        options,
        archived ? "inventory.archive" : "inventory.restore",
        itemId,
        current.version,
        {},
      ),
    );
    return next;
  });
}

async function requiredItem(
  database: HomeOSDatabase,
  itemId: string,
  householdId: string,
): Promise<StoredInventoryItem> {
  const item = await database.items.get(itemId);
  if (!item || item.householdId !== householdId) throw new Error("Inventory item not found.");
  return item;
}

async function outboxOperation(
  database: HomeOSDatabase,
  options: LocalCommandOptions,
  kind: OutboxOperationKind,
  entityId: string,
  expectedVersion: number,
  payload: unknown,
): Promise<OutboxOperation> {
  const previous = (
    await database.outbox.where("householdId").equals(options.householdId).sortBy("order")
  ).at(-1);
  return {
    operationId: commandId(options),
    householdId: options.householdId,
    deviceId: options.deviceId ?? deviceId(),
    kind,
    entityId,
    expectedVersion,
    clientTime: commandNow(options),
    createdAt: commandNow(options),
    order: (previous?.order ?? 0) + 1,
    payload,
    state: "pending",
  };
}

function commandNow(options: LocalCommandOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function commandId(options: LocalCommandOptions): string {
  return options.newId?.() ?? crypto.randomUUID();
}

function deviceId(): string {
  const key = "home-os-device-id";
  const existing = globalThis.localStorage?.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  globalThis.localStorage?.setItem(key, created);
  return created;
}

function normalizeList(values: string[], excluded = ""): string[] {
  const seen = new Set<string>();
  const excludedKey = excluded.trim().toLocaleLowerCase();
  return values.flatMap((value) => {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (!trimmed || key === excludedKey || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
}

function simpleLevel(percentage: number): InventoryItem["stockLevel"] {
  if (percentage <= 0) return "out";
  if (percentage <= 25) return "low";
  if (percentage <= 75) return "okay";
  return "full";
}

function exactLevel(quantity: number, minimum: number): InventoryItem["stockLevel"] {
  if (quantity <= 0) return "out";
  if (quantity <= minimum) return "low";
  return "okay";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
