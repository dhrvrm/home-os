import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError, request } from "@/lib/api";
import {
  publishAccessBoundary,
  resumeHouseholdWork,
  setActiveMemberId,
} from "@/auth/work";
import { householdCommand, householdRead, operationIntent } from "./api";
import { readCopy, writeCopy } from "./cache";
import type { AuthUser } from "@/lib/auth";
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  request: vi.fn(),
}));
vi.mock("./cache", () => ({
  readCopy: vi.fn(),
  writeCopy: vi.fn(async (_user, _domain, data) => ({
    data,
    savedAt: "2026-11-12T00:00:00Z",
    cached: false,
  })),
}));
const user: AuthUser = {
  id: "me",
  householdId: "home",
  role: "member",
  name: "Me",
  email: "me@example.com",
};
const valid = (data: unknown): data is { recipes: unknown[] } =>
  !!data &&
  typeof data === "object" &&
  "recipes" in data &&
  Array.isArray(data.recipes);
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resumeHouseholdWork();
  setActiveMemberId(user.id);
  publishAccessBoundary("ready", user);
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});
describe("household requests", () => {
  it("retains operation IDs for uncertain retries and changes them for a new payload/version", async () => {
    const first = operationIntent(
      null,
      "/recipes/r",
      "PATCH",
      { name: "Rice" },
      2,
    );
    expect(
      operationIntent(first, "/recipes/r", "PATCH", { name: "Rice" }, 2),
    ).toBe(first);
    expect(
      operationIntent(first, "/recipes/r", "PATCH", { name: "Dal" }, 2)
        .operationId,
    ).not.toBe(first.operationId);
    expect(
      operationIntent(first, "/recipes/r", "PATCH", { name: "Rice" }, 3)
        .operationId,
    ).not.toBe(first.operationId);
    vi.mocked(request).mockResolvedValue({});
    await householdCommand("/recipes/r", "PATCH", { name: "Rice" }, first, 2);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/recipes/r",
      expect.objectContaining({
        headers: { "X-Operation-ID": first.operationId, "If-Match": "2" },
      }),
    );
  });
  it("rejects a late previous-member response before caching", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(request).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const promise = householdRead(user, "recipes", "/api/v1/recipes", valid);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    setActiveMemberId("other");
    publishAccessBoundary("ready", { id: "other", householdId: "home" });
    finish({ recipes: [] });
    await expect(promise).rejects.toThrow(/access changed/);
    expect(writeCopy).not.toHaveBeenCalled();
  });
  it("returns a current-member saved copy only on transport failure", async () => {
    vi.mocked(request).mockRejectedValue(
      new APIError("Offline", "network_error"),
    );
    vi.mocked(readCopy).mockResolvedValue({
      data: { recipes: [] },
      savedAt: "2026-11-12T00:00:00Z",
      cached: true,
    });
    expect(
      (await householdRead(user, "recipes", "/api/v1/recipes", valid)).cached,
    ).toBe(true);
    vi.mocked(request).mockRejectedValue(
      new APIError("No access", "unauthorized"),
    );
    await expect(
      householdRead(user, "recipes", "/api/v1/recipes", valid),
    ).rejects.toThrow("No access");
    expect(readCopy).toHaveBeenCalledTimes(1);
  });
  it("refuses offline writes instead of adding an inventory outbox item", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await expect(householdCommand("/recipes", "POST", {})).rejects.toThrow(
      /Connect/,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
