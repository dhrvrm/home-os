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
  householdId: string;
  fetcher?: typeof fetch;
}

const activeSyncs = new WeakMap<HomeOSDatabase, Map<string, Promise<{ accepted: number; conflicts: number; cursor: number }>>>();

export function syncInventory(
  database: HomeOSDatabase,
  options: SyncOptions,
): Promise<{ accepted: number; conflicts: number; cursor: number }> {
  const databaseSyncs = activeSyncs.get(database) ?? new Map();
  activeSyncs.set(database, databaseSyncs);
  const active = databaseSyncs.get(options.householdId);
  if (active) return active;
  const operation = performSync(database, options).finally(() => {
    databaseSyncs.delete(options.householdId);
    if (databaseSyncs.size === 0) activeSyncs.delete(database);
  });
  databaseSyncs.set(options.householdId, operation);
  return operation;
}

export async function hydrateAuthoritativeItems(
  database: HomeOSDatabase,
  items: InventoryItem[],
  householdId: string,
): Promise<void> {
  await database.transaction("rw", database.items, async () => {
    for (const item of items) {
      const local = await database.items.get(item.id);
      if (local && local.householdId !== householdId) continue;
      if (local && local.syncState !== "synced") continue;
      await database.items.put({
        ...item,
        householdId,
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
  householdId: string,
): Promise<StoredInventoryItem> {
  const stored: StoredInventoryItem = {
    ...item,
    householdId,
    version: item.version ?? 1,
    archivedAt: item.archivedAt ?? null,
    syncState: "synced",
  };
  await database.transaction("rw", [database.items, database.outbox], async () => {
    const operation = await database.outbox.get(operationId);
    if (!operation || operation.householdId !== householdId) {
      throw new Error("The local operation belongs to another household.");
    }
    await database.items.put(stored);
    await database.outbox.delete(operationId);
  });
  return stored;
}

export async function pendingOperationForItem(
  database: HomeOSDatabase,
  itemId: string,
  householdId: string,
): Promise<OutboxOperation | undefined> {
  const operations = await database.outbox.where("entityId").equals(itemId).sortBy("order");
  return operations.filter((operation) => operation.householdId === householdId).at(-1);
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
  const householdId = options.householdId;
  const fetcher = options.fetcher ?? fetch;
  const syncState = (await database.syncState.get(householdId)) ?? emptySyncState(householdId);
  const operations = (
    await database.outbox.where("householdId").equals(householdId).sortBy("order")
  ).filter((operation) => operation.state === "pending");
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
          householdId,
          version: item.version ?? 1,
          archivedAt: item.archivedAt ?? null,
          syncState: conflict ? "conflict" : "synced",
        });
      }
      if (data.events.length) {
        await database.stockEvents.bulkPut(
          data.events.map((event) => ({
            ...event,
            householdId,
            actorId: event.actorId ?? "unknown-member",
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
      if (data.activity.length) {
        await database.activity.bulkPut(data.activity.map((event) => ({ ...event, householdId })));
      }
      await pruneActivity(database, householdId, now);
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

async function pruneActivity(database: HomeOSDatabase, householdId: string, now: string): Promise<void> {
  const cutoff = new Date(new Date(now).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const householdEvents = await database.activity.where("householdId").equals(householdId).toArray();
  const expiredByAge = householdEvents.filter((event) => event.serverTime < cutoff).map((event) => event.id);
  if (expiredByAge.length) await database.activity.bulkDelete(expiredByAge);
  const retained = householdEvents
    .filter((event) => !expiredByAge.includes(event.id))
    .sort((left, right) => left.sequence - right.sequence);
  if (retained.length > 2_000) {
    await database.activity.bulkDelete(retained.slice(0, retained.length - 2_000).map((event) => event.id));
  }
}

function emptySyncState(householdId: string): HouseholdSyncState {
  return { householdId, cursor: 0, lastSyncedAt: null, lastError: null };
}
