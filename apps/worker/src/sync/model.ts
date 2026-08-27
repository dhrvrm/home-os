import type { AuditEvent } from "../platform/audit";
import type { InventoryItem, StockEvent } from "../inventory/model";

export type SyncOperationKind =
  | "inventory.create"
  | "inventory.update"
  | "inventory.stock"
  | "inventory.archive"
  | "inventory.restore";

export interface SyncOperation {
  operationId: string;
  householdId: string;
  deviceId: string;
  kind: SyncOperationKind;
  entityId: string;
  expectedVersion: number;
  clientTime: string;
  payload: unknown;
}

export interface SyncAcceptedResult {
  operationId: string;
  status: "accepted";
}

export interface SyncConflictResult {
  operationId: string;
  status: "conflict" | "rejected";
  error: { code: string; message: string; field?: string };
  item?: InventoryItem;
}

export interface SyncResponse {
  results: Array<SyncAcceptedResult | SyncConflictResult>;
  items: InventoryItem[];
  events: StockEvent[];
  activity: AuditEvent[];
  cursor: number;
}
