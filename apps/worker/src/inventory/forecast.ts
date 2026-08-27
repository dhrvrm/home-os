import type { Cadence, Confidence, Forecast, InventoryItem, StockEvent } from "./model";

const DAY_MS = 24 * 60 * 60 * 1000;

export function calculateForecast(item: InventoryItem, events: StockEvent[], now: Date): Forecast | undefined {
  if (item.trackingMode !== "exact" || item.quantity <= 0) return undefined;

  const consumptions = events.filter(
    (event) => event.type === "consume" && event.quantity > 0 && new Date(event.occurredAt) <= now,
  );
  if (consumptions.length < 2) return undefined;

  const total = consumptions.reduce((sum, event) => sum + event.quantity, 0);
  const earliest = Math.min(...consumptions.map((event) => new Date(event.occurredAt).getTime()));
  const days = Math.max(1, (now.getTime() - earliest) / DAY_MS);
  const dailyUsage = total / days;
  if (dailyUsage <= 0) return undefined;

  return {
    dailyUsage: roundOne(dailyUsage),
    daysRemaining: roundOne(item.quantity / dailyUsage),
    confidence: confidenceFor(consumptions.length),
  };
}

export function calculateCadence(events: StockEvent[], now: Date): Cadence | undefined {
  const times = events
    .filter((event) => event.type === "consume" && new Date(event.occurredAt) <= now)
    .map((event) => new Date(event.occurredAt).getTime())
    .sort((left, right) => left - right);
  if (times.length < 2) return undefined;

  const spanDays = (times.at(-1)! - times[0]!) / DAY_MS;
  if (spanDays <= 0) return undefined;
  const averageIntervalDays = spanDays / (times.length - 1);

  return {
    averageIntervalDays: roundOne(averageIntervalDays),
    eventsPerWeek: roundOne(7 / averageIntervalDays),
    lastConsumedAt: new Date(times.at(-1)!).toISOString(),
    confidence: confidenceFor(times.length),
  };
}

function confidenceFor(count: number): Confidence {
  if (count >= 8) return "high";
  if (count >= 4) return "medium";
  return "low";
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
