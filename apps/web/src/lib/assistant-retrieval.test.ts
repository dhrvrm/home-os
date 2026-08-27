import { describe, expect, it } from "vitest";
import type { InventoryItem } from "./inventory";
import { retrieveInventory } from "./assistant-retrieval";

const base: InventoryItem = {
  id: "base",
  name: "Base item",
  alternativeNames: [],
  category: "Other",
  categories: ["Other"],
  location: "Store",
  unit: "item",
  trackingMode: "simple",
  quantity: 0,
  stockLevel: "okay",
  levelPercent: 50,
  minQuantity: 0,
  createdAt: "2026-08-24T10:00:00Z",
  updatedAt: "2026-08-24T10:00:00Z",
};

const items: InventoryItem[] = [
  {
    ...base,
    id: "soap",
    name: "Dish soap",
    alternativeNames: ["साबुन", "Washing-up liquid"],
    category: "Cleaning",
    categories: ["Cleaning", "Kitchen"],
    location: "Under sink",
    unit: "bottle",
    stockLevel: "low",
    levelPercent: 20,
  },
  {
    ...base,
    id: "rice",
    name: "Basmati rice",
    alternativeNames: ["चावल"],
    category: "Food",
    categories: ["Food", "Kitchen"],
    location: "Pantry",
    unit: "kg",
    trackingMode: "exact",
    quantity: 3,
  },
  {
    ...base,
    id: "bulb",
    name: "Spare bulb",
    category: "Maintenance",
    categories: ["Maintenance"],
    location: "Hall cupboard",
    stockLevel: "out",
    levelPercent: 0,
  },
];

describe("assistant inventory retrieval", () => {
  it("ranks exact primary names and multilingual alternatives first", () => {
    const primary = retrieveInventory("How much Basmati rice is left?", items);
    expect(primary.evidence[0]).toMatchObject({ item: { id: "rice" }, matchedFields: expect.arrayContaining(["name"]) });

    const alternative = retrieveInventory("साबुन कहाँ है?", items);
    expect(alternative.evidence[0]).toMatchObject({ item: { id: "soap" }, matchedFields: expect.arrayContaining(["alternativeName"]) });
    expect(alternative.normalizedTerms).toContain("साबुन");
  });

  it("uses category, location, stock, and unit fields as evidence", () => {
    expect(retrieveInventory("Food in pantry", items).evidence[0]).toMatchObject({
      item: { id: "rice" },
      matchedFields: expect.arrayContaining(["category", "location"]),
    });
    expect(retrieveInventory("Which bottles are low?", items).evidence[0]).toMatchObject({
      item: { id: "soap" },
      matchedFields: expect.arrayContaining(["stockLevel", "unit"]),
    });
    expect(retrieveInventory("What is completely empty?", items).evidence[0]).toMatchObject({
      item: { id: "bulb" },
      matchedFields: expect.arrayContaining(["stockLevel"]),
    });
  });

  it("falls back to attention-first records for broad unmatched language", () => {
    const result = retrieveInventory("What should we deal with next?", items);
    expect(result.strategy).toBe("attention-fallback");
    expect(result.evidence.map(({ item }) => item.id)).toEqual(["bulb", "soap", "rice"]);
  });

  it("is deterministic, removes duplicate query terms, and never mutates input", () => {
    const before = structuredClone(items);
    const first = retrieveInventory("rice RICE rice", items);
    const second = retrieveInventory("rice RICE rice", items);
    expect(first).toEqual(second);
    expect(first.normalizedTerms).toEqual(["rice"]);
    expect(items).toEqual(before);
  });

  it("keeps stable source order for equal scores", () => {
    const equal = [
      { ...base, id: "one", name: "One", categories: ["Shared"], category: "Shared" },
      { ...base, id: "two", name: "Two", categories: ["Shared"], category: "Shared" },
    ];
    expect(retrieveInventory("Shared", equal).evidence.map(({ item }) => item.id)).toEqual(["one", "two"]);
  });

  it("bounds evidence while preserving the best match across 1,000 records", () => {
    const many = Array.from({ length: 1_000 }, (_, index) => ({
      ...base,
      id: `item-${index}`,
      name: index === 999 ? "Special atta flour" : `Household item ${index}`,
      alternativeNames: index === 999 ? ["आटा"] : [],
    }));
    const result = retrieveInventory("Where is आटा?", many);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].item.id).toBe("item-999");
    expect(result.totalItems).toBe(1_000);
    expect(result.omittedItems).toBe(999);
  });

  it("honors a smaller explicit limit and handles an empty collection", () => {
    expect(retrieveInventory("Kitchen", items, 2).evidence).toHaveLength(2);
    expect(retrieveInventory("anything", [])).toEqual({
      evidence: [], totalItems: 0, omittedItems: 0, normalizedTerms: ["anything"], strategy: "attention-fallback",
    });
  });
});
