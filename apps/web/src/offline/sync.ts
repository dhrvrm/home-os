import type { HomeOSDatabase } from "./db";
import type {
  HouseholdSyncState,
  OutboxOperation,
  StoredAuditEvent,
  StoredInventoryItem,
  StoredStockEvent,
} from "./schema";
import type { InventoryItem } from "@/lib/inventory";

interface SyncResultRow {
  operationId: string;
  status: "accepted" | "conflict" | "rejected";
  error?: { code: string; message: string; field?: string };
  item?: StoredInventoryItem;
}

interface SyncResponse {
  results: SyncResultRow[];
  items: StoredInventoryItem[];
  events: StoredStockEvent[];
  activity: StoredAuditEvent[];
  cursor: number;
}

interface SyncEnvelope {
  data: SyncResponse | null;
  error: { code: string; message: string } | null;
}

export interface SyncOptions {
  householdId?: string;
  fetcher?: typeof fetch;
}

const activeSyncs = new WeakMap<HomeOSDatabase, Promise<{ accepted: number; conflicts: number; cursor: number }>>();

export function syncInventory(
  database: HomeOSDatabase,
  options: SyncOptions = {},
): Promise<{ accepted: number; conflicts: number; cursor: number }> {
  const active = activeSyncs.get(database);
  if (active) return active;
  const operation = performSync(database, options).finally(() => activeSyncs.delete(database));
  activeSyncs.set(database, operation);
  return operation;
}

export async function hydrateAuthoritativeItems(
  database: HomeOSDatabase,
  items: InventoryItem[],
  householdId = "home",
): Promise<void> {
  await database.transaction("rw", database.items, async () => {
    for (const item of items) {
      const local = await database.items.get(item.id);
      if (local && local.syncState !== "synced") continue;
      await database.items.put({
        ...item,
        householdId: item.householdId ?? householdId,
        version: item.version ?? 1,
        archivedAt: item.archivedAt ?? null,
        syncState: "synced",
      });
    }
  });
}

export async function reconcileDirectMutation(
  database: HomeOSDatabase,
  operationId: string,
  item: InventoryItem,
  householdId = "home",
): Promise<StoredInventoryItem> {
  const stored: StoredInventoryItem = {
    ...item,
    householdId: item.householdId ?? householdId,
    version: item.version ?? 1,
    archivedAt: item.archivedAt ?? null,
    syncState: "synced",
  };
  await database.transaction("rw", [database.items, database.outbox], async () => {
    await database.items.put(stored);
    await database.outbox.delete(operationId);
  });
  return stored;
}

export async function pendingOperationForItem(
  database: HomeOSDatabase,
  itemId: string,
): Promise<OutboxOperation | undefined> {
  const operations = await database.outbox.where("entityId").equals(itemId).sortBy("order");
  return operations.at(-1);
}

export async function markDirectConflict(
  database: HomeOSDatabase,
  operation: OutboxOperation,
  error: { code: string; message: string; field?: string },
): Promise<void> {
  await database.transaction("rw", [database.items, database.outbox], async () => {
    await database.outbox.update(operation.operationId, { state: "conflict", error });
    await database.items.update(operation.entityId, { syncState: "conflict" });
  });
}

async function performSync(
  database: HomeOSDatabase,
  options: SyncOptions,
): Promise<{ accepted: number; conflicts: number; cursor: number }> {
  const householdId = options.householdId ?? "home";
  const fetcher = options.fetcher ?? fetch;
  const syncState = (await database.syncState.get(householdId)) ?? emptySyncState(householdId);
  const operations = await database.outbox.where("state").equals("pending").sortBy("order");
  const operationIds = operations.map((operation) => operation.operationId);
  await markOutbox(database, operationIds, "sending");

  let response: Response;
  try {
    response = await fetcher("/api/v1/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cursor: syncState.cursor, operations: operations.map(wireOperation) }),
    });
  } catch (error) {
    await markOutbox(database, operationIds, "pending");
    throw error;
  }

  const envelope = (await response.json()) as SyncEnvelope;
  if (!response.ok || !envelope.data) {
    await markOutbox(database, operationIds, "pending");
    throw new Error(envelope.error?.message ?? "Home OS could not synchronize.");
  }
  const data = envelope.data;
  const accepted = new Set(data.results.filter((result) => result.status === "accepted").map((result) => result.operationId));
  const conflicts = data.results.filter((result) => result.status !== "accepted");
  const now = new Date().toISOString();

  await database.transaction(
    "rw",
    [database.items, database.stockEvents, database.outbox, database.activity, database.syncState],
    async () => {
      for (const item of data.items) {
        const conflict = conflicts.some((result) => result.item?.id === item.id || operations.find(
          (operation) => operation.operationId === result.operationId,
        )?.entityId === item.id);
        await database.items.put({
          ...item,
          householdId: item.householdId ?? householdId,
          version: item.version ?? 1,
          archivedAt: item.archivedAt ?? null,
          syncState: conflict ? "conflict" : "synced",
        });
      }
      if (data.events.length) {
        await database.stockEvents.bulkPut(
          data.events.map((event) => ({
            ...event,
            householdId: event.householdId ?? householdId,
            actorId: event.actorId ?? "local-owner",
            createdAt: event.createdAt ?? event.occurredAt,
          })),
        );
      }
      for (const operationId of accepted) await database.outbox.delete(operationId);
      for (const result of conflicts) {
        await database.outbox.update(result.operationId, {
          state: "conflict",
          error: result.error ?? { code: "conflict", message: "Review this change before retrying." },
        });
      }
      if (data.activity.length) await database.activity.bulkPut(data.activity);
      await pruneActivity(database, now);
      await database.syncState.put({
        householdId,
        cursor: data.cursor,
        lastSyncedAt: now,
        lastError: null,
      });
    },
  );
  return { accepted: accepted.size, conflicts: conflicts.length, cursor: data.cursor };
}

function wireOperation(operation: OutboxOperation) {
  return {
    operationId: operation.operationId,
    householdId: operation.householdId,
    deviceId: operation.deviceId,
    kind: operation.kind,
    entityId: operation.entityId,
    expectedVersion: operation.expectedVersion,
    clientTime: operation.clientTime,
    payload: operation.payload,
  };
}

async function markOutbox(
  database: HomeOSDatabase,
  operationIds: string[],
  state: OutboxOperation["state"],
): Promise<void> {
  if (!operationIds.length) return;
  await database.transaction("rw", database.outbox, async () => {
    for (const operationId of operationIds) await database.outbox.update(operationId, { state });
  });
}

async function pruneActivity(database: HomeOSDatabase, now: string): Promise<void> {
  const cutoff = new Date(new Date(now).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await database.activity.where("serverTime").below(cutoff).delete();
  const count = await database.activity.count();
  if (count <= 2_000) return;
  const expired = await database.activity.orderBy("sequence").limit(count - 2_000).primaryKeys();
  await database.activity.bulkDelete(expired);
}

function emptySyncState(householdId: string): HouseholdSyncState {
  return { householdId, cursor: 0, lastSyncedAt: null, lastError: null };
}
