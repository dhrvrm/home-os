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
  version: number;
  forecast?: Forecast;
  cadence?: Cadence;
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
}

export interface UpdateItemInput {
  name?: string;
  alternativeNames?: string[];
  categories?: string[];
  location?: string;
  unit?: string;
  minQuantity?: number;
}

export interface ApplyStockEventInput {
  id?: string;
  type: StockEventType;
  quantity?: number;
  stockLevel?: StockLevel;
  levelPercent?: number;
  note?: string;
}
