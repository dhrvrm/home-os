export type TrackingMode = "simple" | "exact";
export type StockLevel = "full" | "okay" | "low" | "out";
export type EventType = "consume" | "restock" | "mark_level";

export interface Forecast {
  dailyUsage: number;
  daysRemaining: number;
  confidence: "low" | "medium" | "high";
}

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  location: string;
  unit: string;
  trackingMode: TrackingMode;
  quantity: number;
  stockLevel: StockLevel;
  minQuantity: number;
  forecast?: Forecast;
  createdAt: string;
  updatedAt: string;
}

export interface CreateItemInput {
  name: string;
  category: string;
  location: string;
  unit: string;
  trackingMode: TrackingMode;
  quantity: number;
  minQuantity: number;
}

export interface ApplyEventInput {
  type: EventType;
  quantity?: number;
  stockLevel?: StockLevel;
}
