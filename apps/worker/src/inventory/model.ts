export type TrackingMode = "simple" | "exact";
export type StockLevel = "full" | "okay" | "low" | "out";
export type StockEventType = "consume" | "restock" | "mark_level";
export type Confidence = "low" | "medium" | "high";
export type ArchivedFilter = "exclude" | "only" | "include";

export interface Forecast {
  dailyUsage: number;
  daysRemaining: number;
  confidence: Confidence;
}

export interface Cadence {
  averageIntervalDays: number;
  eventsPerWeek: number;
  lastConsumedAt: string;
  confidence: Confidence;
}

export type RestockDueStatus = "ok" | "due_soon" | "overdue";

export interface RestockDue {
  intervalDays: number;
  lastRestockedAt: string | null;
  daysSinceRestock: number;
  dueInDays: number;
  status: RestockDueStatus;
}

export type AttentionReason = "low_stock" | "out_of_stock" | "due_soon" | "overdue";

export interface InventoryItem {
  id: string;
  householdId: string;
  name: string;
  alternativeNames: string[];
  category: string;
  categories: string[];
  location: string;
  unit: string;
  trackingMode: TrackingMode;
  quantity: number;
  stockLevel: StockLevel;
  levelPercent: number;
  minQuantity: number;
  restockIntervalDays: number | null;
  version: number;
  forecast?: Forecast;
  cadence?: Cadence;
  restockDue?: RestockDue;
  attentionReasons?: AttentionReason[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockEvent {
  id: string;
  householdId: string;
  itemId: string;
  type: StockEventType;
  quantity: number;
  stockLevel: StockLevel;
  levelPercent: number;
  note: string;
  actorId: string;
  occurredAt: string;
  createdAt: string;
}

export interface InventoryFilter {
  query?: string;
  category?: string;
  stockLevel?: StockLevel;
  archived?: ArchivedFilter;
}

export interface CreateItemInput {
  id?: string;
  name: string;
  alternativeNames?: string[];
  category?: string;
  categories?: string[];
  location?: string;
  unit?: string;
  trackingMode?: TrackingMode;
  quantity?: number;
  stockLevel?: StockLevel;
  levelPercent?: number;
  minQuantity?: number;
  restockIntervalDays?: number | null;
}

export interface UpdateItemInput {
  name?: string;
  alternativeNames?: string[];
  categories?: string[];
  location?: string;
  unit?: string;
  minQuantity?: number;
  restockIntervalDays?: number | null;
}

export interface ApplyStockEventInput {
  id?: string;
  type: StockEventType;
  quantity?: number;
  stockLevel?: StockLevel;
  levelPercent?: number;
  note?: string;
}
