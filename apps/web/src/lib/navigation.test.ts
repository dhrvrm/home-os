import { describe, expect, it } from "vitest";
import { householdDestination, readHouseholdLocation } from "./navigation";

describe("shareable household navigation", () => {
  it("opens a notification meal link without depending on current sign-in", () => {
    expect(readHouseholdLocation("?view=menu&meal=meal-123")).toEqual({ view: "menu", mealId: "meal-123", recipeId: undefined });
    expect(readHouseholdLocation("?view=menu&recipe=dal-123")).toEqual({ view: "menu", mealId: undefined, recipeId: "dal-123" });
  });

  it("keeps malformed views and unrelated or unsafe record ids out of the destination", () => {
    expect(readHouseholdLocation("?view=unknown&meal=meal-123").view).toBe("inventory");
    expect(readHouseholdLocation("?view=contacts&meal=meal-123").mealId).toBeUndefined();
    expect(readHouseholdLocation("?view=menu&meal=%2F%2Fevil.example").mealId).toBeUndefined();
  });

  it("builds same-origin destinations and drops stale meal selections on section change", () => {
    expect(householdDestination("https://home.example/?view=menu&meal=old&other=keep", "contacts")).toBe("/?view=contacts&other=keep");
    expect(householdDestination("https://home.example/", "menu", { mealId: "meal-123" })).toBe("/?view=menu&meal=meal-123");
  });
});
