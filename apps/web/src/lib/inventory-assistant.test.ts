import { describe, expect, it } from "vitest";
import type { InventoryItem } from "./inventory";
import { buildAssistantContext, buildAssistantPrompt, parseModelCommand, proposalInput, runDeterministicQuery } from "./inventory-assistant";

const items = [
  {
    id: "soap", name: "Dish soap", alternativeNames: ["साबुन", "Soap"], category: "Cleaning", categories: ["Cleaning", "Kitchen"],
    location: "Kitchen", unit: "bottle", trackingMode: "simple", quantity: 0, stockLevel: "low", levelPercent: 25, minQuantity: 0,
    createdAt: "2026-08-24T10:00:00Z", updatedAt: "2026-08-24T10:00:00Z",
  },
  {
    id: "rice", name: "Rice", alternativeNames: ["चावल"], category: "Food", categories: ["Food"], location: "Pantry", unit: "kg",
    trackingMode: "exact", quantity: 3, stockLevel: "okay", levelPercent: 0, minQuantity: 1,
    forecast: { dailyUsage: 0.5, daysRemaining: 6, confidence: "medium" },
    cadence: { averageIntervalDays: 3, eventsPerWeek: 2.33, lastConsumedAt: "2026-08-23T10:00:00Z", confidence: "medium" },
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

  it("answers quantity, status, forecast, cadence, categories, and shopping questions from facts", () => {
    expect(runDeterministicQuery("How much rice is left?", items)).toEqual({
      type: "answer", message: "Rice has 3 kg left.", itemIDs: ["rice"],
    });
    expect(runDeterministicQuery("What is the status of साबुन?", items)).toEqual({
      type: "answer", message: "Dish soap is low at 25%.", itemIDs: ["soap"],
    });
    expect(runDeterministicQuery("When will rice run out?", items)).toEqual({
      type: "answer", message: "Rice may run out in about 6 days (medium confidence).", itemIDs: ["rice"],
    });
    expect(runDeterministicQuery("How often do we use rice?", items)).toEqual({
      type: "answer", message: "Rice is used about every 3 days (2.33 times per week, medium confidence).", itemIDs: ["rice"],
    });
    expect(runDeterministicQuery("What categories is rice in?", items)).toEqual({
      type: "answer", message: "Rice is in Food.", itemIDs: ["rice"],
    });
    expect(runDeterministicQuery("What should I buy?", items)).toMatchObject({ type: "answer", itemIDs: ["soap"] });
  });

  it("explains when forecast or cadence evidence is not available", () => {
    expect(runDeterministicQuery("When will dish soap run out?", items)).toEqual({
      type: "answer", message: "There is not enough consumption history to forecast Dish soap yet.", itemIDs: ["soap"],
    });
    expect(runDeterministicQuery("How often do we use dish soap?", items)).toEqual({
      type: "answer", message: "There is not enough consumption history to estimate how often Dish soap is used yet.", itemIDs: ["soap"],
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

  it("builds model context from bounded retrieved evidence", () => {
    const context = buildAssistantContext("Rename साबुन", items);
    expect(context.retrieval.evidence[0].item.id).toBe("soap");
    expect(context.retrieval.totalItems).toBe(2);
    expect(context.prompt.user).toContain('"id":"soap"');
    expect(context.prompt.user).toContain('"retrievalStrategy":"ranked"');
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

  it("executes model inspect plans against authoritative inventory facts", () => {
    expect(parseModelCommand('{"intent":"inspect","item":"चावल","field":"forecast"}', items)).toEqual({
      type: "answer", message: "Rice may run out in about 6 days (medium confidence).", itemIDs: ["rice"],
    });
    expect(parseModelCommand('{"intent":"inspect","item":"Rice","field":"quantity"}', items)).toEqual({
      type: "answer", message: "Rice has 3 kg left.", itemIDs: ["rice"],
    });
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
    expect(parseModelCommand('{"intent":"inspect","item":"invented","field":"status"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"inspect","item":"Rice","field":"price"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"inspect","item":"Rice","field":"status","answer":"fine"}', items)).toMatchObject({ type: "unsupported" });
    expect(parseModelCommand('{"intent":"help"} trailing {"intent":"delete"}', items)).toMatchObject({ type: "help" });
    expect(parseModelCommand('note {not JSON} then {"intent":"help"}', items)).toMatchObject({ type: "help" });
  });
});
