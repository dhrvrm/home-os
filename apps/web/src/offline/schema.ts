import type { InventoryItem, StockEvent } from "@/lib/inventory";

export type LocalSyncState = "pending" | "syncing" | "synced" | "conflict";
export type OutboxState = "pending" | "sending" | "conflict";
export type OutboxOperationKind =
  | "inventory.create"
  | "inventory.update"
  | "inventory.stock"
  | "inventory.archive"
  | "inventory.restore";

export interface StoredInventoryItem extends InventoryItem {
  householdId: string;
  version: number;
  archivedAt: string | null;
  syncState: LocalSyncState;
}

export interface StoredStockEvent extends StockEvent {
  householdId: string;
  actorId: string;
  createdAt: string;
}

export interface OutboxOperation {
  operationId: string;
  householdId: string;
  deviceId: string;
  kind: OutboxOperationKind;
  entityId: string;
  expectedVersion: number;
  clientTime: string;
  createdAt: string;
  order: number;
  payload: unknown;
  state: OutboxState;
  error?: { code: string; message: string; field?: string };
}

export interface StoredAuditEvent {
  id: string;
  sequence: number;
  householdId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  actorType: "member" | "mcp" | "automation" | "import";
  source: "pwa" | "mcp" | "automation" | "import";
  deviceId: string | null;
  operationId: string;
  clientTime: string | null;
  serverTime: string;
  changes: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown; oldValue?: unknown }>;
  mcpClientId: string | null;
  mcpTool: string | null;
}

export interface HouseholdSyncState {
  householdId: string;
  cursor: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}
