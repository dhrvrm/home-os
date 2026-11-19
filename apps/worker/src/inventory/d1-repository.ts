import { pageLimit, readCursor, writeCursor, type PageInput } from "./validation";
import type { InventoryProjection } from "./repository";
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
    return (await this.selectItems(householdId, { archived: filter.archived, stockLevel: filter.stockLevel })).filter(item => matches(item, filter));
  }

  async listItemsPage(householdId: string, filter: InventoryFilter, page: PageInput) {
    const limit = pageLimit(page), cursor = readCursor(page.cursor);
    const items = await this.selectItems(householdId, filter, { limit: limit + 1, after: cursor[0] ?? "" });
    const hasMore = items.length > limit;
    const selected = items.slice(0, limit);
    // Refine the bounded page with the direct reader's exact field order and
    // Unicode normalization; an empty filtered page can still have continuation.
    return { items: selected.filter(item => matches(item, filter)), nextCursor: hasMore ? writeCursor(selected.at(-1)!.id) : null };
  }

  private async selectItems(householdId: string, filter: InventoryFilter, page?: { limit: number; after: string }): Promise<InventoryItem[]> {
    const clauses = ["i.household_id = ?"], values: (string | number)[] = [householdId];
    if (filter.archived === "only") clauses.push("i.archived_at IS NOT NULL");
    else if (filter.archived !== "include") clauses.push("i.archived_at IS NULL");
    if (filter.stockLevel) { clauses.push("i.stock_level = ?"); values.push(filter.stockLevel); }
    if (filter.category?.trim()) {
      clauses.push("(EXISTS (SELECT 1 FROM inventory_item_categories ic JOIN categories c ON c.id = ic.category_id WHERE ic.item_id = i.id AND c.normalized_name = ?) OR (? = 'other' AND NOT EXISTS (SELECT 1 FROM inventory_item_categories ic WHERE ic.item_id = i.id)))"); values.push(normalize(filter.category), normalize(filter.category));
    }
    if (page) { clauses.push("i.id > ?"); values.push(page.after, page.limit); }
    const result = await this.database.prepare(`SELECT i.* FROM inventory_items i WHERE ${clauses.join(" AND ")} ORDER BY ${page ? "i.id ASC LIMIT ?" : "i.updated_at DESC, i.id ASC"}`).bind(...values).all<ItemRow>();
    if (!result.results.length) return [];
    const ids = result.results.map(row => row.id), placeholders = ids.map(() => '?').join(',');
    const scope = page ? `i.id IN (${placeholders})` : 'i.household_id = ?';
    const scopedValues = page ? ids : [householdId];
    const [names, categories] = await this.database.batch([
      this.database.prepare(`SELECT n.item_id, n.name FROM inventory_alternative_names n JOIN inventory_items i ON i.id = n.item_id WHERE ${scope} ORDER BY n.position`).bind(...scopedValues),
      this.database.prepare(`SELECT ic.item_id, c.name FROM inventory_item_categories ic JOIN categories c ON c.id = ic.category_id JOIN inventory_items i ON i.id = ic.item_id WHERE ${scope} ORDER BY ic.position`).bind(...scopedValues),
    ]);
    const group = (rows: unknown[]) => {
      const map = new Map<string, { name: string }[]>();
      for (const row of rows as { item_id: string; name: string }[]) { const entries = map.get(row.item_id) ?? []; entries.push(row); map.set(row.item_id, entries); }
      return map;
    };
    const n = group(names.results), c = group(categories.results);
    return result.results.map(row => this.mapItem(row, n.get(row.id) ?? [], c.get(row.id) ?? []));
  }

  async projections(householdId: string, itemIds: string[], since: string, now: string): Promise<Map<string, InventoryProjection>> {
    if (!itemIds.length) return new Map();
    const rows = await this.database.prepare(`SELECT item_id,
      COUNT(CASE WHEN event_type = 'consume' AND occurred_at >= ? THEN 1 END) AS consumedCount,
      COUNT(CASE WHEN event_type = 'consume' AND quantity > 0 AND occurred_at >= ? THEN 1 END) AS positiveCount,
      COALESCE(SUM(CASE WHEN event_type = 'consume' AND quantity > 0 AND occurred_at >= ? THEN quantity END), 0) AS consumedQuantity,
      MIN(CASE WHEN event_type = 'consume' AND occurred_at >= ? THEN occurred_at END) AS firstConsumedAt,
      MAX(CASE WHEN event_type = 'consume' AND occurred_at >= ? THEN occurred_at END) AS lastConsumedAt,
      MIN(CASE WHEN event_type = 'consume' AND quantity > 0 AND occurred_at >= ? THEN occurred_at END) AS firstPositiveAt,
      MAX(CASE WHEN event_type = 'restock' THEN occurred_at END) AS restockedAt
      FROM inventory_stock_events WHERE household_id = ? AND item_id IN (${itemIds.map(() => '?').join(',')}) AND (occurred_at <= ? OR event_type = 'restock') GROUP BY item_id`)
      .bind(since, since, since, since, since, since, householdId, ...itemIds, now).all<InventoryProjection & { item_id: string }>();
    return new Map(rows.results.map(row => [row.item_id, row]));
  }

  async listEventsPage(householdId: string, itemId: string | undefined, page: PageInput) {
    const limit = pageLimit(page), cursor = readCursor(page.cursor);
    const rows = await this.database.prepare(`SELECT * FROM inventory_stock_events WHERE household_id = ? ${itemId ? 'AND item_id = ?' : ''} AND (occurred_at > ? OR (occurred_at = ? AND id > ?)) ORDER BY occurred_at ASC, id ASC LIMIT ?`)
      .bind(householdId, ...(itemId ? [itemId] : []), cursor[0] ?? '', cursor[0] ?? '', cursor[1] ?? '', limit + 1).all<EventRow>();
    const selected = rows.results.slice(0, limit);
    return { items: selected.map(mapEvent), nextCursor: rows.results.length > limit ? writeCursor(selected.at(-1)!.occurred_at, selected.at(-1)!.id) : null };
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
    if (item.alternativeNames.length) {
      statements.push(this.database.prepare(`INSERT INTO inventory_alternative_names (item_id, name, normalized_name, position) VALUES ${item.alternativeNames.map(() => '(?, ?, ?, ?)').join(',')}`)
        .bind(...item.alternativeNames.flatMap((name, position) => [item.id, name, normalize(name), position])));
    }
    const categories = await Promise.all(item.categories.map(async (name, position) => ({ id: await stableCategoryId(item.householdId, name), name, position })));
    if (categories.length) {
      statements.push(this.database.prepare(`INSERT INTO categories (id, household_id, name, normalized_name, created_at) VALUES ${categories.map(() => '(?, ?, ?, ?, ?)').join(',')} ON CONFLICT(household_id, normalized_name) DO UPDATE SET name = excluded.name`)
        .bind(...categories.flatMap(category => [category.id, item.householdId, category.name, normalize(category.name), item.updatedAt])));
      statements.push(this.database.prepare(`INSERT INTO inventory_item_categories (item_id, category_id, position) VALUES ${categories.map(() => '(?, ?, ?)').join(',')}`)
        .bind(...categories.flatMap(category => [item.id, category.id, category.position])));
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

function mapEvent(row: EventRow): StockEvent { return { id: row.id, householdId: row.household_id, itemId: row.item_id, type: row.event_type, quantity: row.quantity, stockLevel: row.stock_level, levelPercent: row.level_percent, note: row.note, actorId: row.actor_id, occurredAt: row.occurred_at, createdAt: row.created_at }; }

function matches(item: InventoryItem, filter: InventoryFilter): boolean {
  const query = filter.query?.trim().toLocaleLowerCase();
  const category = filter.category?.trim().toLocaleLowerCase();
  return (!category || item.categories.some(value => value.toLocaleLowerCase() === category)) &&
    (!query || [item.name, ...item.alternativeNames, ...item.categories, item.location].join(" ").toLocaleLowerCase().includes(query));
}
