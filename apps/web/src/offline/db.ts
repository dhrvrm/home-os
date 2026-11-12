import Dexie, { type EntityTable } from "dexie";
import type {
  HouseholdSyncState,
  HouseholdCacheRow,
  OutboxOperation,
  StoredAuditEvent,
  StoredInventoryItem,
  StoredStockEvent,
} from "./schema";

export class HomeOSDatabase extends Dexie {
  items!: EntityTable<StoredInventoryItem, "id">;
  stockEvents!: EntityTable<StoredStockEvent, "id">;
  outbox!: EntityTable<OutboxOperation, "operationId">;
  activity!: EntityTable<StoredAuditEvent, "id">;
  syncState!: EntityTable<HouseholdSyncState, "householdId">;
  householdCache!: EntityTable<HouseholdCacheRow, "key">;

  constructor(name = "home-os") {
    super(name);
    this.version(1).stores({
      items: "&id, householdId, name, *categories, location, stockLevel, archivedAt, syncState, updatedAt",
      stockEvents: "&id, householdId, itemId, occurredAt",
      outbox: "&operationId, householdId, order, state, entityId, kind, createdAt",
      activity: "&id, householdId, sequence, [entityType+entityId], actorId, serverTime",
      syncState: "&householdId",
    });
    this.version(2).stores({
      householdCache: "&key, householdId, memberId",
    });
  }
}

export const homeOSDatabase = new HomeOSDatabase();
