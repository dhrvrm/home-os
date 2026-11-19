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

  return forecastFromSummary(item, consumptions.length, consumptions.reduce((sum, event) => sum + event.quantity, 0), Math.min(...consumptions.map(event => new Date(event.occurredAt).getTime())), now);
}

export function calculateCadence(events: StockEvent[], now: Date): Cadence | undefined {
  const times = events
    .filter((event) => event.type === "consume" && new Date(event.occurredAt) <= now)
    .map((event) => new Date(event.occurredAt).getTime())
    .sort((left, right) => left - right);
  if (times.length < 2) return undefined;

  return cadenceFromSummary(times.length, times[0]!, times.at(-1)!);
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

/** Aggregate projection preserves all observations without loading unbounded histories. */
export function enrichProjection(item: InventoryItem, stats: import("./repository").InventoryProjection | undefined, now: Date): InventoryItem {
  const result = structuredClone(item);
  if (stats?.firstPositiveAt) result.forecast = forecastFromSummary(item, stats.positiveCount, stats.consumedQuantity, new Date(stats.firstPositiveAt).getTime(), now);
  if (!result.forecast) delete result.forecast;
  if (stats?.firstConsumedAt && stats.lastConsumedAt) result.cadence = cadenceFromSummary(stats.consumedCount, new Date(stats.firstConsumedAt).getTime(), new Date(stats.lastConsumedAt).getTime());
  if (!result.cadence) delete result.cadence;
  result.restockDue = calculateRestockDue(item, stats?.restockedAt ?? null, now);
  if (!result.restockDue) delete result.restockDue;
  result.attentionReasons = attentionReasonsFor(result.stockLevel, result.restockDue);
  return result;
}

function forecastFromSummary(item: InventoryItem, count: number, quantity: number, earliest: number, now: Date): Forecast | undefined {
  if (item.trackingMode !== "exact" || item.quantity <= 0 || count < 2) return undefined;
  const usage = quantity / Math.max(1, (now.getTime() - earliest) / DAY_MS);
  if (usage <= 0) return undefined;
  return { dailyUsage: roundOne(usage), daysRemaining: roundOne(item.quantity / usage), confidence: confidenceFor(count) };
}
function cadenceFromSummary(count: number, earliest: number, latest: number): Cadence | undefined {
  const span = (latest - earliest) / DAY_MS;
  if (count < 2 || span <= 0) return undefined;
  const interval = span / (count - 1);
  return { averageIntervalDays: roundOne(interval), eventsPerWeek: roundOne(7 / interval), lastConsumedAt: new Date(latest).toISOString(), confidence: confidenceFor(count) };
}
