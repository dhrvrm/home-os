import { beginCommand, replayCommand, commitCommand } from "../platform/household-command";
import { ConflictError, NotFoundError } from "../platform/errors";
import type { InventoryFilter, InventoryItem, StockEvent } from "./model";
import type { InventoryMutation, InventoryRepository } from "./repository";

interface ItemRow {
  id: string;
  household_id: string;
  name: string;
  location: string;
  unit: string;
  tracking_mode: InventoryItem["trackingMode"];
  quantity: number;
  stock_level: InventoryItem["stockLevel"];
  level_percent: number;
  min_quantity: number;
  restock_interval_days: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface NameRow {
  name: string;
}

interface CategoryRow {
  name: string;
}

interface EventRow {
  id: string;
  household_id: string;
  item_id: string;
  event_type: StockEvent["type"];
  quantity: number;
  stock_level: StockEvent["stockLevel"];
  level_percent: number;
  note: string;
  actor_id: string;
  occurred_at: string;
  created_at: string;
}


export class D1InventoryRepository implements InventoryRepository {
  constructor(private readonly database: D1Database) {}

  async beginMutation(context: import("../platform/context").CommandContext, action: string, entityId: string | undefined, input: unknown) {
    const command = await beginCommand(this.database, context, "inventory_item", action, entityId, input);
    return { command, replay: await replayCommand<InventoryItem>(this.database, command) };
  }


  async listItems(householdId: string, filter: InventoryFilter): Promise<InventoryItem[]> {
    const result = await this.database
      .prepare(
        `SELECT id, household_id, name, location, unit, tracking_mode, quantity,
                stock_level, level_percent, min_quantity, restock_interval_days, version,
                created_at, updated_at, archived_at
           FROM inventory_items
          WHERE household_id = ?
          ORDER BY updated_at DESC, id ASC`,
      )
      .bind(householdId)
      .all<ItemRow>();
    const [names, categories] = await this.database.batch([
      this.database.prepare(`SELECT n.item_id, n.name FROM inventory_alternative_names n JOIN inventory_items i ON i.id = n.item_id WHERE i.household_id = ? ORDER BY n.position`).bind(householdId),
      this.database.prepare(`SELECT ic.item_id, c.name FROM inventory_item_categories ic JOIN categories c ON c.id = ic.category_id JOIN inventory_items i ON i.id = ic.item_id WHERE i.household_id = ? ORDER BY ic.position`).bind(householdId),
    ]);
    const group = (rows: unknown[]) => {
      const map = new Map<string, { name: string }[]>();
      for (const row of rows as { item_id: string; name: string }[]) {
        const entries = map.get(row.item_id) ?? [];
        entries.push(row);
        map.set(row.item_id, entries);
      }
      return map;
    };
    const namesByItem = group(names.results), categoriesByItem = group(categories.results);
    const items = result.results.map(row => this.mapItem(row, namesByItem.get(row.id) ?? [], categoriesByItem.get(row.id) ?? []));
    const query = filter.query?.trim().toLocaleLowerCase();
    const category = filter.category?.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (filter.archived === "only" && item.archivedAt === null) return false;
      if (filter.archived !== "only" && filter.archived !== "include" && item.archivedAt !== null) return false;
      if (filter.stockLevel && item.stockLevel !== filter.stockLevel) return false;
      if (category && !item.categories.some((value) => value.toLocaleLowerCase() === category)) return false;
      if (query) {
        const searchable = [item.name, ...item.alternativeNames, ...item.categories, item.location]
          .join(" ")
          .toLocaleLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });
  }

  async getItem(householdId: string, itemId: string): Promise<InventoryItem> {
    const row = await this.database
      .prepare(
        `SELECT id, household_id, name, location, unit, tracking_mode, quantity,
                stock_level, level_percent, min_quantity, restock_interval_days, version,
                created_at, updated_at, archived_at
           FROM inventory_items
          WHERE household_id = ? AND id = ?`,
      )
      .bind(householdId, itemId)
      .first<ItemRow>();
    if (!row) throw new NotFoundError("inventory_item", itemId);
    return this.hydrateItem(row);
  }

  async createItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT INTO inventory_items (
             id, household_id, name, normalized_name, location, unit, tracking_mode,
             quantity, stock_level, level_percent, min_quantity, restock_interval_days, version,
             created_at, updated_at, archived_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.id,
          item.householdId,
          item.name,
          normalize(item.name),
          item.location,
          item.unit,
          item.trackingMode,
          item.quantity,
          item.stockLevel,
          item.levelPercent,
          item.minQuantity,
          item.restockIntervalDays,
          item.version,
          item.createdAt,
          item.updatedAt,
          item.archivedAt,
        ),
      ...(await this.nameAndCategoryStatements(item, false)),
    ];
    return this.executeMutation(statements, item, mutation);
  }

  async updateItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    const statements: D1PreparedStatement[] = [
      this.guardStatement(item, mutation),
      this.database
        .prepare(
          `UPDATE inventory_items
              SET name = ?, normalized_name = ?, location = ?, unit = ?,
                  min_quantity = ?, restock_interval_days = ?, version = ?, updated_at = ?
            WHERE household_id = ? AND id = ? AND version = ?`,
        )
        .bind(
          item.name,
          normalize(item.name),
          item.location,
          item.unit,
          item.minQuantity,
          item.restockIntervalDays,
          item.version,
          item.updatedAt,
          item.householdId,
          item.id,
          mutation.expectedVersion,
        ),
      ...(await this.nameAndCategoryStatements(item, true)),
      this.releaseGuardStatement(item, mutation),
    ];
    return this.executeMutation(statements, item, mutation);
  }

  async setArchived(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem> {
    return this.executeMutation(
      [
        this.guardStatement(item, mutation),
        this.database
          .prepare(
            `UPDATE inventory_items
                SET archived_at = ?, version = ?, updated_at = ?
              WHERE household_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            item.archivedAt,
            item.version,
            item.updatedAt,
            item.householdId,
            item.id,
            mutation.expectedVersion,
          ),
            this.releaseGuardStatement(item, mutation),
      ],
      item,
      mutation,
    );
  }

  async applyStockEvent(
    item: InventoryItem,
    event: StockEvent,
    mutation: InventoryMutation,
  ): Promise<InventoryItem> {
    return this.executeMutation(
      [
        this.guardStatement(item, mutation),
        this.database
          .prepare(
            `UPDATE inventory_items
                SET quantity = ?, stock_level = ?, level_percent = ?, version = ?, updated_at = ?
              WHERE household_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            item.quantity,
            item.stockLevel,
            item.levelPercent,
            item.version,
            item.updatedAt,
            item.householdId,
            item.id,
            mutation.expectedVersion,
          ),
        this.database
          .prepare(
            `INSERT INTO inventory_stock_events (
               id, household_id, item_id, event_type, quantity, stock_level,
               level_percent, note, actor_id, occurred_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            event.id,
            event.householdId,
            event.itemId,
            event.type,
            event.quantity,
            event.stockLevel,
            event.levelPercent,
            event.note,
            event.actorId,
            event.occurredAt,
            event.createdAt,
          ),
            this.releaseGuardStatement(item, mutation),
      ],
      item,
      mutation,
    );
  }

  async listEvents(householdId: string, itemId: string, since: string): Promise<StockEvent[]> {
    const result = await this.database
      .prepare(
        `SELECT id, household_id, item_id, event_type, quantity, stock_level,
                level_percent, note, actor_id, occurred_at, created_at
           FROM inventory_stock_events
          WHERE household_id = ? AND item_id = ? AND occurred_at >= ?
          ORDER BY occurred_at ASC, id ASC`,
      )
      .bind(householdId, itemId, since)
      .all<EventRow>();
    return result.results.map((row) => ({
      id: row.id,
      householdId: row.household_id,
      itemId: row.item_id,
      type: row.event_type,
      quantity: row.quantity,
      stockLevel: row.stock_level,
      levelPercent: row.level_percent,
      note: row.note,
      actorId: row.actor_id,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    }));
  }

  async listHouseholdEvents(householdId: string, since: string): Promise<StockEvent[]> {
    const rows = await this.database.prepare(`SELECT id, household_id, item_id, event_type, quantity, stock_level, level_percent, note, actor_id, occurred_at, created_at FROM inventory_stock_events WHERE household_id = ? AND occurred_at >= ? ORDER BY occurred_at ASC, id ASC`).bind(householdId, since).all<EventRow>();
    return rows.results.map(row => ({ id: row.id, householdId: row.household_id, itemId: row.item_id, type: row.event_type, quantity: row.quantity, stockLevel: row.stock_level, levelPercent: row.level_percent, note: row.note, actorId: row.actor_id, occurredAt: row.occurred_at, createdAt: row.created_at }));
  }

  async latestRestocks(householdId: string): Promise<Map<string, string>> {
    const rows = await this.database.prepare(`SELECT item_id, MAX(occurred_at) AS occurred_at FROM inventory_stock_events WHERE household_id = ? AND event_type = 'restock' GROUP BY item_id`).bind(householdId).all<{ item_id: string; occurred_at: string }>();
    return new Map(rows.results.map(row => [row.item_id, row.occurred_at]));
  }

  async latestRestockAt(householdId: string, itemId: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        `SELECT occurred_at
           FROM inventory_stock_events
          WHERE household_id = ? AND item_id = ? AND event_type = 'restock'
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(householdId, itemId)
      .first<{ occurred_at: string }>();
    return row?.occurred_at ?? null;
  }

  private async hydrateItem(row: ItemRow): Promise<InventoryItem> {
    const [names, categories] = await this.database.batch([
      this.database
        .prepare("SELECT name FROM inventory_alternative_names WHERE item_id = ? ORDER BY position ASC")
        .bind(row.id),
      this.database
        .prepare(
          `SELECT categories.name
             FROM inventory_item_categories
             JOIN categories ON categories.id = inventory_item_categories.category_id
            WHERE inventory_item_categories.item_id = ?
            ORDER BY inventory_item_categories.position ASC`,
        )
        .bind(row.id),
    ]);
    return this.mapItem(row, names.results as unknown as NameRow[], categories.results as unknown as CategoryRow[]);
  }

  private mapItem(row: ItemRow, names: NameRow[], categories: CategoryRow[]): InventoryItem {
    const alternativeNames = names.map((value) => value.name);
    const categoryValues = categories.map((value) => value.name);
    const safeCategories = categoryValues.length ? categoryValues : ["Other"];
    return {
      id: row.id,
      householdId: row.household_id,
      name: row.name,
      alternativeNames,
      category: safeCategories[0]!,
      categories: safeCategories,
      location: row.location,
      unit: row.unit,
      trackingMode: row.tracking_mode,
      quantity: row.quantity,
      stockLevel: row.stock_level,
      levelPercent: row.level_percent,
      minQuantity: row.min_quantity,
      restockIntervalDays: row.restock_interval_days,
      version: row.version,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async nameAndCategoryStatements(item: InventoryItem, replace: boolean): Promise<D1PreparedStatement[]> {
    const statements: D1PreparedStatement[] = [];
    if (replace) {
      statements.push(
        this.database.prepare("DELETE FROM inventory_alternative_names WHERE item_id = ?").bind(item.id),
        this.database.prepare("DELETE FROM inventory_item_categories WHERE item_id = ?").bind(item.id),
      );
    }
    item.alternativeNames.forEach((name, position) => {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO inventory_alternative_names (item_id, name, normalized_name, position)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(item.id, name, normalize(name), position),
      );
    });
    for (const [position, name] of item.categories.entries()) {
      const categoryId = await stableCategoryId(item.householdId, name);
      statements.push(
        this.database
          .prepare(
            `INSERT INTO categories (id, household_id, name, normalized_name, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(household_id, normalized_name) DO UPDATE SET name = excluded.name`,
          )
          .bind(categoryId, item.householdId, name, normalize(name), item.updatedAt),
        this.database
          .prepare(
            `INSERT INTO inventory_item_categories (item_id, category_id, position)
             VALUES (?, ?, ?)`,
          )
          .bind(item.id, categoryId, position),
      );
    }
    return statements;
  }

  private guardStatement(item: InventoryItem, mutation: InventoryMutation): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO mutation_guards (
           household_id, operation_id, expected_version, actual_version
         ) VALUES (
           ?, ?, ?, COALESCE((SELECT version FROM inventory_items WHERE household_id = ? AND id = ?), -1)
         )`,
      )
      .bind(
        item.householdId,
        mutation.context.operationId,
        mutation.expectedVersion,
        item.householdId,
        item.id,
      );
  }

  private releaseGuardStatement(item: InventoryItem, mutation: InventoryMutation): D1PreparedStatement {
    return this.database
      .prepare("DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?")
      .bind(item.householdId, mutation.context.operationId);
  }

  private async executeMutation(
    statements: D1PreparedStatement[],
    item: InventoryItem,
    mutation: InventoryMutation,
  ): Promise<InventoryItem> {
    if (!mutation.command) throw new Error("Mutation requires verified command admission");
    mutation.command.changes = mutation.changes;
    return commitCommand(this.database, mutation.command, durableItem(item), item.id, item.updatedAt, statements, async () => {
      const current = await this.database.prepare("SELECT version FROM inventory_items WHERE household_id = ? AND id = ?").bind(item.householdId, item.id).first<{ version: number }>();
      if (mutation.expectedVersion > 0) {
        if (!current) throw new NotFoundError("inventory_item", item.id);
        if (current.version !== mutation.expectedVersion) throw new ConflictError("inventory_item", item.id, mutation.expectedVersion, current.version);
      }
    });
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function stableCategoryId(householdId: string, name: string): Promise<string> {
  const input = new TextEncoder().encode(`${householdId}\0${normalize(name)}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `category_${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function durableItem(item: InventoryItem): InventoryItem {
  const clone = structuredClone(item);
  delete clone.forecast;
  delete clone.cadence;
  delete clone.restockDue;
  delete clone.attentionReasons;
  return clone;
}
