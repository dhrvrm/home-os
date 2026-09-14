import type {
  AttentionReason,
  Cadence,
  Confidence,
  Forecast,
  InventoryItem,
  RestockDue,
  StockEvent,
  StockLevel,
} from "./model";

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

export const RESTOCK_DUE_SOON_FRACTION = 0.2;

export function calculateRestockDue(
  item: InventoryItem,
  lastRestockedAt: string | null,
  now: Date,
): RestockDue | undefined {
  if (item.restockIntervalDays === null || item.restockIntervalDays === undefined) return undefined;
  const intervalDays = item.restockIntervalDays;
  const anchor = new Date(lastRestockedAt ?? item.createdAt).getTime();
  const daysSinceRestock = Math.max(0, (now.getTime() - anchor) / DAY_MS);
  const dueInDays = intervalDays - daysSinceRestock;
  const status: RestockDue["status"] =
    dueInDays <= 0 ? "overdue" : dueInDays <= intervalDays * RESTOCK_DUE_SOON_FRACTION ? "due_soon" : "ok";
  return {
    intervalDays,
    lastRestockedAt,
    daysSinceRestock: roundOne(daysSinceRestock),
    dueInDays: roundOne(dueInDays),
    status,
  };
}

export function attentionReasonsFor(stockLevel: StockLevel, restockDue: RestockDue | undefined): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (stockLevel === "out") reasons.push("out_of_stock");
  else if (stockLevel === "low") reasons.push("low_stock");
  if (restockDue?.status === "due_soon") reasons.push("due_soon");
  if (restockDue?.status === "overdue") reasons.push("overdue");
  return reasons;
}

function confidenceFor(count: number): Confidence {
  if (count >= 8) return "high";
  if (count >= 4) return "medium";
  return "low";
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
