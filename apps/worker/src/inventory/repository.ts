import type { HouseholdCommand } from "../platform/household-command";
import type { CommandContext } from "../platform/context";
import type { InventoryFilter, InventoryItem, StockEvent } from "./model";

export interface AuditChange {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
  oldValue?: unknown;
}

export interface InventoryMutation {
  command?: HouseholdCommand;
  context: CommandContext;
  action: string;
  expectedVersion: number;
  changes: AuditChange[];
}

export interface InventoryRepository {
  listHouseholdEvents?(householdId: string, since: string): Promise<StockEvent[]>;
  latestRestocks?(householdId: string): Promise<Map<string, string>>;
  beginMutation?(context: CommandContext, action: string, entityId: string | undefined, input: unknown): Promise<{ command: HouseholdCommand; replay: InventoryItem | null }>;
  listItems(householdId: string, filter: InventoryFilter): Promise<InventoryItem[]>;
  getItem(householdId: string, itemId: string): Promise<InventoryItem>;
  createItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem>;
  updateItem(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem>;
  setArchived(item: InventoryItem, mutation: InventoryMutation): Promise<InventoryItem>;
  applyStockEvent(item: InventoryItem, event: StockEvent, mutation: InventoryMutation): Promise<InventoryItem>;
  listEvents(householdId: string, itemId: string, since: string): Promise<StockEvent[]>;
  latestRestockAt(householdId: string, itemId: string): Promise<string | null>;
}
