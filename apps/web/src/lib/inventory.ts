export type TrackingMode = "simple" | "exact";
export type StockLevel = "full" | "okay" | "low" | "out";
export type EventType = "consume" | "restock" | "mark_level";

export interface Forecast {
  dailyUsage: number;
  daysRemaining: number;
  confidence: "low" | "medium" | "high";
}

export interface Cadence {
  averageIntervalDays: number;
  eventsPerWeek: number;
  lastConsumedAt: string;
  confidence: "low" | "medium" | "high";
}

export interface InventoryItem {
  id: string;
  householdId?: string;
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
  version?: number;
  forecast?: Forecast;
  cadence?: Cadence;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockEvent {
  id: string;
  householdId?: string;
  itemId: string;
  type: EventType;
  quantity: number;
  stockLevel?: StockLevel;
  levelPercent: number;
  note?: string;
  actorId?: string;
  occurredAt: string;
  createdAt?: string;
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
  levelPercent?: number;
  minQuantity?: number;
}

export interface ApplyEventInput {
  id?: string;
  type: EventType;
  quantity?: number;
  stockLevel?: StockLevel;
  levelPercent?: number;
  note?: string;
}

export interface UpdateItemInput {
  name?: string;
  alternativeNames?: string[];
  categories?: string[];
  location?: string;
  unit?: string;
  minQuantity?: number;
}

export type UpdateItemMetadataInput = UpdateItemInput;

export interface InventoryExport {
  version: 1;
  exportedAt: string;
  items: Array<{ item: InventoryItem; events: StockEvent[] }>;
}
