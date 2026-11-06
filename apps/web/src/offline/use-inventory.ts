"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  APIError,
  applyEvent,
  archiveItem,
  createItem,
  listItems,
  restoreItem,
  updateItem,
  type MutationRequestOptions,
} from "@/lib/api";
import { loadInventoryCache, saveInventoryCache } from "@/lib/inventory-cache";
import type { ApplyEventInput, CreateItemInput, InventoryItem, UpdateItemInput } from "@/lib/inventory";
import {
  applyLocalStockEvent,
  archiveLocalItem,
  createLocalItem,
  listLocalItems,
  restoreLocalItem,
  updateLocalItem,
} from "./commands";
import { homeOSDatabase } from "./db";
import { AccessChangedError, runHouseholdWork } from "@/auth/work";
import type { OutboxOperation, StoredInventoryItem } from "./schema";
import {
  hydrateAuthoritativeItems,
  markDirectConflict,
  pendingOperationForItem,
  reconcileDirectMutation,
  syncInventory,
} from "./sync";

export type InventoryLoadState = "loading" | "ready" | "error";
export type InventorySyncStatus = "starting" | "syncing" | "synced" | "offline" | "attention";

export function useInventory() {
  const activeItems = useLiveQuery(() => listLocalItems(homeOSDatabase), [], undefined);
  const archivedItems = useLiveQuery(() => listLocalItems(homeOSDatabase, true), [], undefined);
  const [loadState, setLoadState] = useState<InventoryLoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<InventorySyncStatus>("starting");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => runHouseholdWork(async (lease) => {
    setLoadError(null);
    setSyncStatus("syncing");
    try {
      const pending = await homeOSDatabase.outbox.where("state").equals("pending").count();
      if (pending > 0) {
        const result = await syncInventory(homeOSDatabase);
        const unresolved = await homeOSDatabase.outbox.where("state").equals("conflict").count();
        setSyncStatus(result.conflicts > 0 || unresolved > 0 ? "attention" : "synced");
      } else {
        const active = await listItems();
        lease.check();
        await hydrateAuthoritativeItems(homeOSDatabase, active, "home", lease);
        const unresolved = await homeOSDatabase.outbox.where("state").equals("conflict").count();
        setSyncStatus(unresolved > 0 ? "attention" : "synced");
      }
      lease.check();
      const now = new Date().toISOString();
      setLastSyncedAt(now);
      const local = await listLocalItems(homeOSDatabase);
      lease.check();
      saveInventoryCache(local);
      setLoadState("ready");
    } catch (error) {
      if (error instanceof AccessChangedError || (error instanceof APIError && ["unauthorized", "session_changed"].includes(error.code))) return;
      lease.check();
      const count = await homeOSDatabase.items.count();
      const initialized = await homeOSDatabase.syncState.get("home");
      setSyncStatus("offline");
      if (count > 0 || initialized) {
        setLoadState("ready");
      } else {
        setLoadError(error instanceof Error ? error.message : "The inventory could not be loaded.");
        setLoadState("error");
      }
    }
  }).catch((error) => { if (!(error instanceof AccessChangedError)) throw error; }), []);

  useEffect(() => {
    let active = true;
    void runHouseholdWork(async (lease) => {
      if (await homeOSDatabase.items.count() === 0) {
        const legacy = loadInventoryCache();
        if (legacy) {
          lease.check();
          await hydrateAuthoritativeItems(homeOSDatabase, legacy.items, "home", lease);
          lease.check();
          await homeOSDatabase.syncState.put({
            householdId: "home",
            cursor: 0,
            lastSyncedAt: null,
            lastError: null,
          });
        }
      }
      lease.check();
      if (!active) return;
      if (await homeOSDatabase.items.count() > 0) setLoadState("ready");
      await refresh();
    }).catch((error) => {
      if (active && !(error instanceof AccessChangedError)) {
        setLoadError(error instanceof Error ? error.message : "Your saved inventory could not be opened.");
        setLoadState("error");
      }
    });
    const reconnect = () => { void refresh(); };
    const disconnect = () => setSyncStatus("offline");
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      active = false;
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [refresh]);

  const commit = useCallback(async <T extends StoredInventoryItem>(
    localMutation: () => Promise<T>,
    remoteMutation: (local: T, operation: OutboxOperation, options: MutationRequestOptions) => Promise<InventoryItem>,
  ): Promise<InventoryItem> => runHouseholdWork(async (lease) => {
    lease.check();
    const local = await homeOSDatabase.transaction("rw", [homeOSDatabase.items, homeOSDatabase.stockEvents, homeOSDatabase.outbox], async () => {
      lease.check();
      const result = await localMutation();
      lease.check();
      return result;
    });
    lease.check();
    const operation = await pendingOperationForItem(homeOSDatabase, local.id);
    if (!operation) throw new Error("The local change could not be queued.");
    setSyncStatus("syncing");
    try {
      const options: MutationRequestOptions = {
        operationId: operation.operationId,
        expectedVersion: operation.expectedVersion > 0 ? operation.expectedVersion : undefined,
        deviceId: operation.deviceId,
        clientTime: operation.clientTime,
      };
      lease.check();
      const authoritative = await remoteMutation(local, operation, options);
      lease.check();
      const reconciled = await reconcileDirectMutation(homeOSDatabase, operation.operationId, authoritative, "home", lease);
      setSyncStatus("synced");
      setLastSyncedAt(new Date().toISOString());
      return reconciled;
    } catch (error) {
      if (error instanceof AccessChangedError) throw error;
      if (error instanceof APIError && ["unauthorized", "session_changed"].includes(error.code)) {
        // Authentication expiry must not turn a valid queued edit into a conflict.
        throw error;
      }
      lease.check();
      if (isTransportFailure(error)) {
        setSyncStatus("offline");
        return local;
      }
      const problem = error instanceof APIError
        ? { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }
        : { code: "mutation_failed", message: error instanceof Error ? error.message : "The change needs review." };
      await markDirectConflict(homeOSDatabase, operation, problem);
      setSyncStatus("attention");
      throw error;
    }
  }), []);

  const add = useCallback((input: CreateItemInput) => commit(
    () => createLocalItem(homeOSDatabase, input),
    (local, _operation, options) => createItem({ ...input, id: local.id }, options),
  ), [commit]);

  const update = useCallback((itemId: string, input: UpdateItemInput) => commit(
    () => updateLocalItem(homeOSDatabase, itemId, input),
    (_local, _operation, options) => updateItem(itemId, input, options),
  ), [commit]);

  const applyStock = useCallback((itemId: string, input: ApplyEventInput) => commit(
    () => applyLocalStockEvent(homeOSDatabase, itemId, input),
    async (_local, operation, options) => {
      const payload = operation.payload as ApplyEventInput;
      return applyEvent(itemId, payload, options);
    },
  ), [commit]);

  const archive = useCallback((itemId: string) => commit(
    () => archiveLocalItem(homeOSDatabase, itemId),
    (_local, _operation, options) => archiveItem(itemId, options),
  ), [commit]);

  const restore = useCallback((itemId: string) => commit(
    () => restoreLocalItem(homeOSDatabase, itemId),
    (_local, _operation, options) => restoreItem(itemId, options),
  ), [commit]);

  return {
    items: activeItems ?? [],
    archivedItems: archivedItems ?? [],
    loadState,
    loadError,
    syncStatus,
    lastSyncedAt,
    refresh,
    add,
    update,
    applyStock,
    archive,
    restore,
  };
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof APIError && ["network_error", "offline", "timeout"].includes(error.code);
}
