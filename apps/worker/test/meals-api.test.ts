import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { cookingApi, recipeInput } from "./cooking-fixture";
import type { Meal, Recipe } from "../src/meals/model";
async function recipe() {
  const r = await cookingApi("/recipes", "POST", recipeInput);
  expect(r.status).toBe(201);
  return (await r.json<{ data: { recipe: Recipe } }>()).data.recipe;
}
async function meal(recipeId: string) {
  const r = await cookingApi("/meals", "POST", {
    title: "Dinner",
    recipeIds: [recipeId],
    cookingAt: "2090-01-02T13:00:00Z",
    timezone: "Asia/Kolkata",
    reminderMinutesBefore: 60,
  });
  expect(r.status).toBe(201);
  return (await r.json<{ data: { meal: Meal } }>()).data.meal;
}
describe("cooking APIs", () => {
  it("keeps announced snapshots and requires independent current attendance versions", async () => {
    const r = await recipe();
    const m = await meal(r.id);
    expect(
      (
        await cookingApi(`/meals/${m.id}/attendance`, "PUT", {
          response: "yes",
          announcementVersion: 1,
          expectedResponseVersion: 0,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await cookingApi(
          `/meals/${m.id}/attendance`,
          "PUT",
          {
            response: "no",
            announcementVersion: 1,
            expectedResponseVersion: 0,
          },
          { member: "cook-second" },
        )
      ).status,
    ).toBe(200);
    let response = await cookingApi(`/meals/${m.id}`);
    let current = (await response.json<{ data: { meal: Meal } }>()).data.meal;
    expect(current.attendance.counts).toMatchObject({ yes: 1, no: 1 });
    expect(
      (
        await cookingApi(
          `/recipes/${r.id}`,
          "PATCH",
          { name: "New dal" },
          { version: 1 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await cookingApi(`/recipes/${r.id}`, "DELETE", undefined, {
          version: 2,
        })
      ).status,
    ).toBe(200);
    response = await cookingApi(
      `/meals/${m.id}`,
      "PATCH",
      { notes: "Please come" },
      { version: 1 },
    );
    current = (await response.json<{ data: { meal: Meal } }>()).data.meal;
    expect(current.recipes[0].name).toBe("Dal");
    expect(current.announcementVersion).toBe(1);
    expect(current.attendance.counts.yes).toBe(1);
    response = await cookingApi(
      `/meals/${m.id}`,
      "PATCH",
      { cookingAt: "2090-01-02T14:00:00Z" },
      { version: 2 },
    );
    current = (await response.json<{ data: { meal: Meal } }>()).data.meal;
    expect(current.announcementVersion).toBe(2);
    expect(current.attendance.counts.yes).toBe(0);
    expect(current.myAttendance?.needsReconfirmation).toBe(true);
    expect(
      (
        await cookingApi(`/meals/${m.id}/attendance`, "PUT", {
          response: "yes",
          announcementVersion: 1,
          expectedResponseVersion: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await cookingApi(`/meals/${m.id}/attendance`, "PUT", {
          response: "yes",
          announcementVersion: 2,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await cookingApi(`/meals/${m.id}/attendance`, "PUT", {
          response: "yes",
          announcementVersion: 2,
          expectedResponseVersion: 0,
        })
      ).status,
    ).toBe(409);
  });
  it("binds retries to intent, actor, target and audit operation uniqueness", async () => {
    const concurrentOp = crypto.randomUUID();
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        cookingApi("/recipes", "POST", recipeInput, {
          operation: concurrentOp,
        }),
      ),
    );
    expect(concurrent.map((x) => x.status)).toEqual([201, 201]);
    const accepted = await Promise.all(
      concurrent.map((x) => x.json<{ data: { recipe: Recipe } }>()),
    );
    expect(accepted[0].data.recipe.id).toBe(accepted[1].data.recipe.id);
    const op = crypto.randomUUID();
    const first = await cookingApi("/recipes", "POST", recipeInput, {
      operation: op,
    });
    const original = (await first.json<{ data: { recipe: Recipe } }>()).data
      .recipe;
    const retry = await cookingApi("/recipes", "POST", recipeInput, {
      operation: op,
    });
    expect(
      (await retry.json<{ data: { recipe: Recipe } }>()).data.recipe.id,
    ).toBe(original.id);
    expect(
      (
        await cookingApi(
          "/recipes",
          "POST",
          { ...recipeInput, name: "other" },
          { operation: op },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await cookingApi("/recipes", "POST", recipeInput, {
          operation: op,
          member: "another-cook",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await cookingApi(
          "/contacts",
          "POST",
          { name: "Doctor", role: "Doctor" },
          { operation: op },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_events WHERE operation_id=?",
        )
          .bind(op)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await cookingApi(`/recipes/${original.id}`, "PATCH", {
          name: "Changed",
        })
      ).status,
    ).toBe(400);
    const changes = await Promise.all(
      ["A", "B"].map((name) =>
        cookingApi(
          `/recipes/${original.id}`,
          "PATCH",
          { name },
          { version: 1 },
        ),
      ),
    );
    expect(changes.map((x) => x.status).sort()).toEqual([200, 409]);
  });
  it("serializes competing self answers while allowing independent people to answer concurrently", async () => {
    const r = await recipe();
    const m = await meal(r.id);
    const input = { announcementVersion: 1, expectedResponseVersion: 0 };
    const own = await Promise.all(
      ["yes", "no"].map((response) =>
        cookingApi(`/meals/${m.id}/attendance`, "PUT", { ...input, response }),
      ),
    );
    expect(own.map((x) => x.status).sort()).toEqual([200, 409]);
    const people = await Promise.all(
      ["parallel-cook-one", "parallel-cook-two"].map((member) =>
        cookingApi(
          `/meals/${m.id}/attendance`,
          "PUT",
          { ...input, response: "yes" },
          { member },
        ),
      ),
    );
    expect(people.map((x) => x.status)).toEqual([200, 200]);
    const current = (
      await (
        await cookingApi(`/meals/${m.id}`)
      ).json<{ data: { meal: Meal } }>()
    ).data.meal;
    expect(
      current.attendance.participants
        .filter((p) => p.memberId.startsWith("parallel-cook"))
        .every((p) => p.response === "yes"),
    ).toBe(true);
  });
  it("enforces admission, strict bodies, household zone and bounded dates", async () => {
    expect(
      (await cookingApi("/recipes", "GET", undefined, { authenticated: false }))
        .status,
    ).toBe(401);
    expect(
      (
        await cookingApi("/recipes", "POST", recipeInput, {
          member: "cooking-viewer",
          role: "viewer",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await cookingApi("/recipes", "POST", {
          ...recipeInput,
          actorId: "spoof",
        })
      ).status,
    ).toBe(400);
    const r = await recipe();
    expect(
      (
        await cookingApi("/meals", "POST", {
          title: "Dinner",
          recipeIds: [r.id],
          cookingAt: "2090-01-01T12:00:00Z",
          timezone: "UTC",
        })
      ).status,
    ).toBe(400);
    expect(
      (await cookingApi("/meals?from=2090-01-01&to=2090-02-02")).status,
    ).toBe(400);
    expect(
      (await cookingApi("/meals?from=2090-01-01&to=2090-01-08")).status,
    ).toBe(200);
    expect(
      (
        await cookingApi("/recipes", "POST", {
          ...recipeInput,
          ingredients: [{ name: "Foreign", inventoryItemId: "missing" }],
        })
      ).status,
    ).toBe(400);
  });
});
