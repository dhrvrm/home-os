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

it("allowlists personal action and consent intents and returns from fresh aliases to root", () => {
  expect(readHouseholdLocation("?view=account&action=password")).toMatchObject({ view: "account", action: "password" });
  expect(readHouseholdLocation("?view=members&action=reset-password&member=ravi")).toMatchObject({ action: "reset-password", memberId: "ravi" });
  expect(readHouseholdLocation("?view=members&action=reset-password&member=%2Fevil").action).toBeUndefined();
  expect(readHouseholdLocation("?view=account&action=enable").action).toBeUndefined();
  expect(readHouseholdLocation("?connect=" + "a".repeat(32))).toMatchObject({ view: "account", connect: "a".repeat(32) });
  expect(readHouseholdLocation("?connect=evil").connect).toBeUndefined();
  expect(householdDestination("https://home.example/api/oauth/consent?connect=" + "a".repeat(32), "inventory")).toBe("/?view=inventory");
});
