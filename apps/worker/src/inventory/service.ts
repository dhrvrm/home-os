import type { CommandContext } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";
import { calculateCadence, calculateForecast } from "./forecast";
import type {
  ApplyStockEventInput,
  CreateItemInput,
  InventoryFilter,
  InventoryItem,
  StockEvent,
  UpdateItemInput,
} from "./model";
import type { AuditChange, InventoryMutation, InventoryRepository } from "./repository";
import {
  assertLength,
  assertNonNegative,
  assertPercentage,
  assertPositive,
  exactStockLevel,
  isStockLevel,
  normalizeValues,
  percentageForLevel,
  simpleStockLevel,
  trimmed,
  withDefault,
} from "./validation";

interface InventoryServiceOptions {
  now?: () => Date;
  newId?: () => string;
}

export class InventoryService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly repository: InventoryRepository,
    options: InventoryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? createId;
  }

  async listItems(householdId: string, filter: InventoryFilter = {}): Promise<InventoryItem[]> {
    const items = await this.repository.listItems(householdId, {
      ...filter,
      archived: filter.archived ?? "exclude",
    });
    return Promise.all(items.map((item) => this.enrich(item)));
  }

  async getItem(householdId: string, itemId: string): Promise<InventoryItem> {
    return this.enrich(await this.repository.getItem(householdId, itemId.trim()));
  }

  async createItem(context: CommandContext, input: CreateItemInput): Promise<InventoryItem> {
    const name = trimmed(input.name);
    if (!name) throw new ValidationError("name", "enter an item name");
    assertLength("name", name, 120);

    const quantity = input.quantity ?? 0;
    const minQuantity = input.minQuantity ?? 0;
    assertNonNegative("quantity", quantity);
    assertNonNegative("minQuantity", minQuantity);

    const alternativeNames = normalizeValues("alternativeNames", input.alternativeNames ?? [], {
      excluded: name,
      maximumCount: 8,
      maximumLength: 120,
    });
    const categoryInput = input.categories?.length
      ? input.categories
      : input.category
        ? [input.category]
        : ["Other"];
    const categories = normalizeValues("categories", categoryInput, {
      maximumCount: 9,
      maximumLength: 60,
    });
    if (categories.length === 0) categories.push("Other");

    const trackingMode = input.trackingMode ?? "simple";
    if (trackingMode !== "simple" && trackingMode !== "exact") {
      throw new ValidationError("trackingMode", "must be simple or exact");
    }

    let levelPercent = 0;
    let stockLevel;
    if (trackingMode === "exact") {
      stockLevel = exactStockLevel(quantity, minQuantity);
    } else {
      if (input.levelPercent !== undefined) {
        assertPercentage(input.levelPercent);
        levelPercent = input.levelPercent;
      } else if (isStockLevel(input.stockLevel)) {
        levelPercent = percentageForLevel(input.stockLevel);
      } else {
        levelPercent = 50;
      }
      stockLevel = simpleStockLevel(levelPercent);
    }

    const location = withDefault(input.location, "Unassigned");
    const unit = withDefault(input.unit, "item");
    assertLength("location", location, 80);
    assertLength("unit", unit, 30);
    const timestamp = this.now().toISOString();
    const item: InventoryItem = {
      id: this.newId(),
      householdId: context.householdId,
      name,
      alternativeNames,
      category: categories[0]!,
      categories,
      location,
      unit,
      trackingMode,
      quantity,
      stockLevel,
      levelPercent,
      minQuantity,
      version: 1,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return this.repository.createItem(item, {
      context,
      action: "inventory.item.created",
      expectedVersion: 0,
      changes: createdFields(item),
    });
  }

  async updateItem(context: CommandContext, itemId: string, input: UpdateItemInput): Promise<InventoryItem> {
    const current = await this.repository.getItem(context.householdId, itemId.trim());
    const next = structuredClone(current);

    if (input.name !== undefined) {
      next.name = trimmed(input.name);
      if (!next.name) throw new ValidationError("name", "enter an item name");
      assertLength("name", next.name, 120);
    }
    if (input.alternativeNames !== undefined) {
      next.alternativeNames = normalizeValues("alternativeNames", input.alternativeNames, {
        excluded: next.name,
        maximumCount: 8,
        maximumLength: 120,
      });
    } else if (input.name !== undefined) {
      next.alternativeNames = normalizeValues("alternativeNames", next.alternativeNames, {
        excluded: next.name,
        maximumCount: 8,
        maximumLength: 120,
      });
    }
    if (input.categories !== undefined) {
      next.categories = normalizeValues("categories", input.categories, {
        maximumCount: 9,
        maximumLength: 60,
      });
      if (next.categories.length === 0) {
        throw new ValidationError("categories", "choose at least one category");
      }
      next.category = next.categories[0]!;
    }
    if (input.location !== undefined) {
      next.location = withDefault(input.location, "Unassigned");
      assertLength("location", next.location, 80);
    }
    if (input.unit !== undefined) {
      next.unit = withDefault(input.unit, "item");
      assertLength("unit", next.unit, 30);
    }
    if (input.minQuantity !== undefined) {
      assertNonNegative("minQuantity", input.minQuantity);
      next.minQuantity = input.minQuantity;
    }

    next.updatedAt = this.now().toISOString();
    next.version = current.version + 1;
    const changes = changedFields(current, next, [
      "name",
      "alternativeNames",
      "categories",
      "location",
      "unit",
      "minQuantity",
    ]);
    const updated = await this.repository.updateItem(
      next,
      this.mutation(context, "inventory.item.updated", current.version, changes),
    );
    return this.enrich(updated);
  }

  async applyStockEvent(
    context: CommandContext,
    itemId: string,
    input: ApplyStockEventInput,
  ): Promise<InventoryItem> {
    if (input.type !== "consume" && input.type !== "restock" && input.type !== "mark_level") {
      throw new ValidationError("type", "must be consume, restock, or mark_level");
    }
    const note = trimmed(input.note);
    assertLength("note", note, 240);
    const current = await this.repository.getItem(context.householdId, itemId.trim());
    const next = structuredClone(current);
    let eventQuantity = input.quantity ?? 0;

    if (input.type === "consume") {
      if (current.trackingMode === "exact") {
        assertPositive("quantity", eventQuantity);
        eventQuantity = Math.min(eventQuantity, current.quantity);
        next.quantity = current.quantity - eventQuantity;
        next.stockLevel = exactStockLevel(next.quantity, current.minQuantity);
      } else {
        if (eventQuantity === 0) eventQuantity = 25;
        assertNonNegative("quantity", eventQuantity);
        next.levelPercent = Math.max(0, current.levelPercent - eventQuantity);
        next.stockLevel = simpleStockLevel(next.levelPercent);
      }
    } else if (input.type === "restock") {
      if (current.trackingMode === "exact") {
        assertPositive("quantity", eventQuantity);
        next.quantity = current.quantity + eventQuantity;
        next.stockLevel = exactStockLevel(next.quantity, current.minQuantity);
      } else {
        next.levelPercent = 100;
        next.stockLevel = "full";
      }
    } else if (current.trackingMode === "simple") {
      assertPercentage(input.levelPercent);
      next.levelPercent = input.levelPercent;
      next.stockLevel = simpleStockLevel(input.levelPercent);
    } else {
      if (!isStockLevel(input.stockLevel)) {
        throw new ValidationError("stockLevel", "must be full, okay, low, or out");
      }
      next.stockLevel = input.stockLevel;
      if (input.stockLevel === "out") next.quantity = 0;
    }

    const timestamp = this.now().toISOString();
    next.updatedAt = timestamp;
    next.version = current.version + 1;
    const event: StockEvent = {
      id: this.newId(),
      householdId: context.householdId,
      itemId: current.id,
      type: input.type,
      quantity: eventQuantity,
      stockLevel: next.stockLevel,
      levelPercent: next.levelPercent,
      note,
      actorId: context.actorId,
      occurredAt: timestamp,
      createdAt: timestamp,
    };
    const changes = changedFields(current, next, ["quantity", "stockLevel", "levelPercent"]);
    const updated = await this.repository.applyStockEvent(
      next,
      event,
      this.mutation(context, `inventory.stock.${input.type}`, current.version, changes),
    );
    return this.enrich(updated);
  }

  async archiveItem(context: CommandContext, itemId: string): Promise<InventoryItem> {
    return this.setArchived(context, itemId, true);
  }

  async restoreItem(context: CommandContext, itemId: string): Promise<InventoryItem> {
    return this.setArchived(context, itemId, false);
  }

  async listEvents(householdId: string, itemId: string, since = new Date(0).toISOString()): Promise<StockEvent[]> {
    await this.repository.getItem(householdId, itemId.trim());
    return this.repository.listEvents(householdId, itemId.trim(), since);
  }

  private async setArchived(context: CommandContext, itemId: string, archived: boolean): Promise<InventoryItem> {
    const current = await this.repository.getItem(context.householdId, itemId.trim());
    if ((current.archivedAt !== null) === archived) return this.enrich(current);

    const next = structuredClone(current);
    next.archivedAt = archived ? this.now().toISOString() : null;
    next.updatedAt = this.now().toISOString();
    next.version = current.version + 1;
    const updated = await this.repository.setArchived(
      next,
      this.mutation(
        context,
        archived ? "inventory.item.archived" : "inventory.item.restored",
        current.version,
        changedFields(current, next, ["archivedAt"]),
      ),
    );
    return this.enrich(updated);
  }

  private mutation(
    context: CommandContext,
    action: string,
    currentVersion: number,
    changes: AuditChange[],
  ): InventoryMutation {
    return {
      context,
      action,
      expectedVersion: context.expectedVersion ?? currentVersion,
      changes,
    };
  }

  private async enrich(item: InventoryItem): Promise<InventoryItem> {
    const now = this.now();
    const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const events = await this.repository.listEvents(item.householdId, item.id, since);
    const enriched = structuredClone(item);
    const forecast = calculateForecast(enriched, events, now);
    const cadence = calculateCadence(events, now);
    if (forecast) enriched.forecast = forecast;
    else delete enriched.forecast;
    if (cadence) enriched.cadence = cadence;
    else delete enriched.cadence;
    return enriched;
  }
}

function changedFields(
  before: InventoryItem,
  after: InventoryItem,
  fields: Array<keyof InventoryItem>,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    changes.push({
      op: "replace",
      path: `/${field}`,
      oldValue: before[field],
      value: after[field],
    });
  }
  return changes;
}

function createdFields(item: InventoryItem): AuditChange[] {
  const fields: Array<keyof InventoryItem> = [
    "name",
    "alternativeNames",
    "categories",
    "location",
    "unit",
    "trackingMode",
    "quantity",
    "stockLevel",
    "levelPercent",
    "minQuantity",
  ];
  return fields.map((field) => ({ op: "add", path: `/${field}`, value: item[field] }));
}
