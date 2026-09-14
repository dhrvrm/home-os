import { describe, expect, it } from "vitest";
import type { InventoryItem } from "./inventory";
import { computeRestockDue, needsAttention } from "./restock";

const item = {
  createdAt: "2026-09-01T00:00:00.000Z",
  restockIntervalDays: 10,
  stockLevel: "okay",
} as InventoryItem;

describe("computeRestockDue", () => {
  it("returns undefined without an interval", () => {
    expect(computeRestockDue({ ...item, restockIntervalDays: null }, null, new Date("2026-09-10T00:00:00.000Z"))).toBeUndefined();
  });

  it("mirrors the worker derivation: ok, due_soon, overdue", () => {
    const anchor = "2026-09-05T00:00:00.000Z";
    expect(computeRestockDue(item, anchor, new Date("2026-09-08T00:00:00.000Z"))?.status).toBe("ok");
    expect(computeRestockDue(item, anchor, new Date("2026-09-13T12:00:00.000Z"))?.status).toBe("due_soon");
    expect(computeRestockDue(item, anchor, new Date("2026-09-16T00:00:00.000Z"))?.status).toBe("overdue");
  });

  it("anchors on createdAt when never restocked", () => {
    const due = computeRestockDue(item, null, new Date("2026-09-12T00:00:00.000Z"));
    expect(due?.lastRestockedAt).toBeNull();
    expect(due?.status).toBe("overdue");
  });
});

describe("needsAttention", () => {
  it("combines stock level with declared due status", () => {
    expect(needsAttention({ ...item, stockLevel: "low" })).toBe(true);
    expect(needsAttention({ ...item, stockLevel: "okay", restockDue: { intervalDays: 10, lastRestockedAt: null, daysSinceRestock: 9, dueInDays: 1, status: "due_soon" } })).toBe(true);
    expect(needsAttention({ ...item, stockLevel: "okay" })).toBe(false);
  });
});
