import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth";
import type { WorkLease } from "@/auth/work";
vi.mock("@/offline/db", async (original) => {
  const actual = await original<typeof import("@/offline/db")>();
  return {
    ...actual,
    homeOSDatabase: new actual.HomeOSDatabase(
      `household-cache-test-${crypto.randomUUID()}`,
    ),
  };
});
import { homeOSDatabase } from "@/offline/db";
import { cacheKey, readCopy, writeCopy } from "./cache";
const user: AuthUser = {
  id: "me",
  householdId: "home",
  role: "member",
  name: "Me",
  email: "me@example.com",
};
const valid = (data: unknown): data is { name: string } =>
  !!data &&
  typeof data === "object" &&
  "name" in data &&
  typeof data.name === "string";
function lease(check = vi.fn()): WorkLease {
  return {
    memberId: user.id,
    proof: { memberId: user.id, boundary: null, generation: 0 },
    check,
  };
}
beforeEach(async () => {
  await homeOSDatabase.householdCache.clear();
});
afterAll(async () => {
  await homeOSDatabase.delete();
});
describe("household saved copies", () => {
  it("separates member and household domains", async () => {
    await writeCopy(user, "recipes", { name: "Private dish" }, lease());
    expect((await readCopy(user, "recipes", valid, lease()))?.data.name).toBe(
      "Private dish",
    );
    expect(
      await readCopy({ ...user, id: "other" }, "recipes", valid, lease()),
    ).toBeNull();
    expect(
      await readCopy(
        { ...user, householdId: "other" },
        "recipes",
        valid,
        lease(),
      ),
    ).toBeNull();
    expect(await readCopy(user, "contacts", valid, lease())).toBeNull();
  });
  it("rejects corrupt saved values and mismatched row ownership", async () => {
    const key = cacheKey(user, "recipes");
    await homeOSDatabase.householdCache.put({
      key,
      householdId: "home",
      memberId: "me",
      data: { name: 4 },
      savedAt: new Date().toISOString(),
    });
    expect(await readCopy(user, "recipes", valid, lease())).toBeNull();
    await homeOSDatabase.householdCache.update(key, {
      data: { name: "Dish" },
      memberId: "other",
    });
    expect(await readCopy(user, "recipes", valid, lease())).toBeNull();
  });
  it("aborts the write transaction if access changes before commit", async () => {
    let checks = 0;
    await expect(
      writeCopy(
        user,
        "recipes",
        { name: "Dish" },
        lease(
          vi.fn(() => {
            checks++;
            if (checks === 3) throw new Error("Access changed");
          }),
        ),
      ),
    ).rejects.toThrow("Access changed");
    expect(await homeOSDatabase.householdCache.count()).toBe(0);
  });
});
