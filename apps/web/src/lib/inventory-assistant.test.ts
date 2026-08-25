import { describe, expect, it } from "vitest";
import type { InventoryItem } from "./inventory";
import { buildAssistantPrompt, parseModelCommand, proposalInput, runDeterministicQuery } from "./inventory-assistant";

const items = [
  {
    id: "soap", name: "Dish soap", alternativeNames: ["साबुन", "Soap"], category: "Cleaning", categories: ["Cleaning", "Kitchen"],
    location: "Kitchen", unit: "bottle", trackingMode: "simple", quantity: 0, stockLevel: "low", levelPercent: 25, minQuantity: 0,
    createdAt: "2026-08-24T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z",
  },
  {
    id: "rice", name: "Rice", alternativeNames: ["चावल"], category: "Food", categories: ["Food"], location: "Pantry", unit: "kg",
    trackingMode: "exact", quantity: 3, stockLevel: "okay", levelPercent: 0, minQuantity: 1,
    createdAt: "2026-08-24T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z",
  },
] satisfies InventoryItem[];

describe("inventory assistant", () => {
  it("answers common stock and count queries without a model", () => {
    expect(runDeterministicQuery("What is running low?", items)).toMatchObject({ type: "answer", itemIDs: ["soap"] });
    expect(runDeterministicQuery("How many items do we have?", items)).toEqual({
      type: "answer", message: "2 items are tracked at home.", itemIDs: ["soap", "rice"],
    });
  });

  it("finds an item by Hindi alternative name", () => {
    expect(runDeterministicQuery("Where is चावल?", items)).toEqual({
      type: "answer", message: "Rice is in Pantry.", itemIDs: ["rice"],
    });
  });

  it("distinguishes known categories from locations", () => {
    expect(runDeterministicQuery("What's in Food?", items)).toMatchObject({ type: "answer", itemIDs: ["rice"] });
    expect(runDeterministicQuery("What's in Pantry?", items)).toMatchObject({ type: "answer", itemIDs: ["rice"] });
    const colliding = [...items, { ...items[1], id: "snack", name: "Snack", category: "Cleaning", categories: ["Cleaning"], location: "Food" }];
    expect(runDeterministicQuery("What's in Food?", colliding)).toMatchObject({ type: "unsupported" });
    expect(runDeterministicQuery("What's in Food category?", colliding)).toMatchObject({ type: "answer", itemIDs: ["rice"] });
    expect(runDeterministicQuery("What's in Food location?", colliding)).toMatchObject({ type: "answer", itemIDs: ["snack"] });
    for (const request of ["Show items in Food", "Show items in Food category", "Show me items in Food category"]) {
      expect(runDeterministicQuery(request, items)).toMatchObject({ type: "answer", itemIDs: ["rice"] });
    }
  });

  it("builds a bounded prompt containing inventory and allowed categories", () => {
    const prompt = buildAssistantPrompt("rename soap", items);
    expect(prompt.system).toContain("Return exactly one compact JSON object");
    expect(prompt.system).toContain("Personal care");
    expect(prompt.user).toContain('"id":"soap"');
    expect(prompt.user).toContain("साबुन");
  });

  it("keeps the prompt within its inventory budget and prioritizes the requested item", () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...items[1], id: `item-${index}`, name: `Stored household item ${index} with a descriptive name`, alternativeNames: [`Alternative household name ${index}`],
    }));
    const prompt = buildAssistantPrompt("Rename Stored household item 99 with a descriptive name", many);
    expect(new TextEncoder().encode(prompt.system + prompt.user).byteLength).toBeLessThanOrEqual(3_800);
    expect(prompt.user).toContain('"id":"item-99"');
    expect(prompt.user).toContain('"omittedItemCount":');
  });

  it("bounds the complete multilingual prompt with maximum valid custom categories", () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...items[0],
      id: `बहुभाषी-${index}`,
      name: `घरेलू वस्तु ${index} ${"क".repeat(90)}`,
      alternativeNames: Array.from({ length: 8 }, (__, alias) => `वैकल्पिक ${alias} ${"न".repeat(100)}`),
      categories: Array.from({ length: 9 }, (__, category) => `श्रेणी ${category} ${"ग".repeat(45)}`),
      category: `श्रेणी 0 ${"ग".repeat(45)}`,
      location: `स्थान ${"ल".repeat(60)}`,
    }));
    const prompt = buildAssistantPrompt(`नाम बदलो घरेलू वस्तु 99 ${"क".repeat(90)}`, many);
    expect(new TextEncoder().encode(prompt.system + prompt.user).byteLength).toBeLessThanOrEqual(3_800);
    expect(prompt.user).toContain('"id":"बहुभाषी-99"');
  });

  it("parses a safe rename proposal and strips the new primary name from aliases", () => {
    const result = parseModelCommand('Result: {"intent":"rename","item":"साबुन","name":"Washing-up liquid","alternativeNames":["Soap","Washing-up liquid"]}', items);
    expect(result).toMatchObject({
      type: "proposal", itemID: "soap", itemName: "Dish soap",
      changes: { name: "Washing-up liquid", alternativeNames: ["Soap"] },
    });
    if (result.type === "proposal") expect(proposalInput(result)).toEqual(result.changes);
  });

  it("adds and removes only allowlisted categories", () => {
    expect(parseModelCommand('{"intent":"categorize","item":"Rice","addCategories":["Kitchen"],"removeCategories":["Food"]}', items)).toMatchObject({
      type: "proposal", itemID: "rice", current: { categories: ["Food"] }, changes: { categories: ["Kitchen"] },
    });
    expect(parseModelCommand('{"intent":"categorize","item":"Rice","addCategories":["Secret"]}', items)).toMatchObject({ type: "unsupported" });
  });

  it("preserves current values for an explicit before and after review", () => {
    expect(parseModelCommand('{"intent":"aliases","item":"Dish soap","alternativeNames":[]}', items)).toMatchObject({
      type: "proposal",
      current: { alternativeNames: ["साबुन", "Soap"] },
      changes: { alternativeNames: [] },
    });
  });

  it("fails closed for malformed, invented, ambiguous, and overlong commands", () => {
    expect(parseModelCommand("not json", items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"rename","item":"invented","name":"New"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand(JSON.stringify({ intent: "rename", item: "Rice", name: "x".repeat(121) }), items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"delete","item":"Rice"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"rename","item":"Rice","name":"New","location":"Garage"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"help"} trailing {"intent":"delete"}', items)).toMatchObject({ type: "help" });
    expect(parseModelCommand('note {not JSON} then {"intent":"help"}', items)).toMatchObject({ type: "help" });
  });
});
