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
  forecast?: Forecast;
  cadence?: Cadence;
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemInput {
  name: string;
  alternativeNames?: string[];
  category?: string;
  categories?: string[];
  location: string;
  unit: string;
  trackingMode: TrackingMode;
  quantity: number;
  levelPercent?: number;
  minQuantity: number;
}

export interface ApplyEventInput {
  type: EventType;
  quantity?: number;
  stockLevel?: StockLevel;
  levelPercent?: number;
}
