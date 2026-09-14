import type { InventoryItem, RestockDue } from "./inventory";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RESTOCK_DUE_SOON_FRACTION = 0.2;

export function computeRestockDue(
  item: Pick<InventoryItem, "restockIntervalDays" | "createdAt">,
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

export function needsAttention(item: InventoryItem): boolean {
  if (item.stockLevel === "low" || item.stockLevel === "out") return true;
  return item.restockDue?.status === "due_soon" || item.restockDue?.status === "overdue";
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}
