import type { Cadence, Forecast, InventoryItem, StockLevel } from "./inventory";

export function stockLabel(level: StockLevel): string {
  return { full: "Full", okay: "Okay", low: "Low", out: "Out" }[level];
}

export function quantityLabel(item: InventoryItem): string {
  if (item.trackingMode === "simple") return stockLabel(item.stockLevel);
  const value = Number.isInteger(item.quantity) ? String(item.quantity) : item.quantity.toFixed(1);
  return `${value} ${item.unit}${item.quantity === 1 ? "" : "s"}`;
}

export function forecastLabel(forecast?: Forecast): string {
  if (!forecast) return "Learning usage";
  if (forecast.daysRemaining < 1) return "Likely out today";
  const days = Math.max(1, Math.round(forecast.daysRemaining));
  return `About ${days} day${days === 1 ? "" : "s"} left`;
}

export function cadenceLabel(cadence?: Cadence): string {
  if (!cadence) return "Learning usage";
  const days = Math.max(1, Math.round(cadence.averageIntervalDays));
  return `Used about every ${days} day${days === 1 ? "" : "s"}`;
}

export function relativeUpdate(value: string): string {
  const timestamp = new Date(value).getTime();
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}
