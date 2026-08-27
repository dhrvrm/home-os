import { describe, expect, it, vi } from "vitest";
import type { InventoryItem } from "./inventory";
import { clearInventoryCache, loadInventoryCache, saveInventoryCache } from "./inventory-cache";

const cacheKey = "home-os:inventory:v1";

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "rice",
    name: "Basmati rice",
    alternativeNames: ["चावल"],
    category: "Pantry",
    categories: ["Pantry", "Staples"],
    location: "Kitchen",
    unit: "kg",
    trackingMode: "exact",
    quantity: 2.5,
    stockLevel: "okay",
    levelPercent: 50,
    minQuantity: 1,
    forecast: { dailyUsage: 0.1, daysRemaining: 25, confidence: "medium" },
    cadence: {
      averageIntervalDays: 2,
      eventsPerWeek: 3.5,
      lastConsumedAt: "2026-08-26T08:00:00.000Z",
      confidence: "high",
    },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

describe("inventory cache", () => {
  it("round-trips a versioned inventory projection and clears it", () => {
    const storage = localStorage;
    storage.clear();

    expect(saveInventoryCache([item()], storage, new Date("2026-08-27T09:30:00.000Z"))).toBe(true);
    expect(JSON.parse(storage.getItem(cacheKey) ?? "null")).toMatchObject({ version: 1 });
    expect(loadInventoryCache(storage)).toEqual({
      items: [item()],
      savedAt: "2026-08-27T09:30:00.000Z",
    });

    expect(clearInventoryCache(storage)).toBe(true);
    expect(loadInventoryCache(storage)).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, savedAt: "2026-08-27T09:30:00.000Z", items: [] }),
    JSON.stringify({ version: 1, savedAt: "not-a-date", items: [] }),
  ])("rejects corrupt or unsupported payloads", (serialized) => {
    localStorage.setItem(cacheKey, serialized);
    expect(loadInventoryCache(localStorage)).toBeNull();
  });

  it("rejects an invalid item instead of exposing it to the UI", () => {
    localStorage.setItem(cacheKey, JSON.stringify({
      version: 1,
      savedAt: "2026-08-27T09:30:00.000Z",
      items: [{ ...item(), trackingMode: "estimated", levelPercent: 150 }],
    }));

    expect(loadInventoryCache(localStorage)).toBeNull();
  });

  it("normalizes optional aliases and categories and tolerates missing analytics", () => {
    const cachedItem = item();
    const minimalItem: Partial<InventoryItem> = { ...cachedItem };
    delete minimalItem.alternativeNames;
    delete minimalItem.categories;
    delete minimalItem.forecast;
    delete minimalItem.cadence;
    localStorage.setItem(cacheKey, JSON.stringify({
      version: 1,
      savedAt: "2026-08-27T09:30:00.000Z",
      items: [minimalItem],
    }));

    expect(loadInventoryCache(localStorage)?.items[0]).toEqual({
      ...minimalItem,
      alternativeNames: [],
      categories: ["Pantry"],
    });
  });

  it("does not throw when storage access or quota operations fail", () => {
    const error = new DOMException("Storage unavailable", "QuotaExceededError");
    const storage = {
      getItem: vi.fn(() => { throw error; }),
      setItem: vi.fn(() => { throw error; }),
      removeItem: vi.fn(() => { throw error; }),
    };

    expect(() => saveInventoryCache([item()], storage)).not.toThrow();
    expect(saveInventoryCache([item()], storage)).toBe(false);
    expect(loadInventoryCache(storage)).toBeNull();
    expect(clearInventoryCache(storage)).toBe(false);
  });
});
