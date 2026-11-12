import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { MealService } from "../src/meals/service";
import { D1MealRepository } from "../src/meals/d1-repository";
import {
  isMealReminderEligible,
  listDueMealReminders,
} from "../src/meals/reminders";
import { ValidationError } from "../src/platform/errors";
import { cookingInstant, menuBounds } from "../src/meals/time";
import type { CommandContext } from "../src/platform/context";
import { cookingApi, recipeInput } from "./cooking-fixture";
function context(version?: number, op = crypto.randomUUID()): CommandContext {
  return {
    householdId: "home",
    actorId: "local-owner",
    actorType: "member",
    source: "pwa",
    operationId: op,
    expectedVersion: version,
  };
}
function fixture() {
  let now = "2090-01-01T10:00:00.000Z";
  const service = new MealService(new D1MealRepository(env.DB), () => now);
  return {
    service,
    setNow: (value: string) => {
      now = value;
    },
  };
}
async function stock(
  id: string,
  mode: string,
  quantity: number,
  unit: string,
  level = "full",
) {
  await env.DB.prepare(
    "INSERT INTO inventory_items (id,household_id,name,normalized_name,location,unit,tracking_mode,quantity,stock_level,level_percent,min_quantity,created_at,updated_at) VALUES (?,'home',?,?,'Kitchen',?,?,?,?,100,0,'2090-01-01','2090-01-01')",
  )
    .bind(id, id, id, unit, mode, quantity, level)
    .run();
}
describe("cooking rules against real D1", () => {
  it("qualifies exact stock honestly and never changes quantities", async () => {
    const { service } = fixture();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await stock(ids[0], "exact", 3, "kg");
    await stock(ids[1], "simple", 1, "kg");
    await stock(ids[2], "exact", 0, "kg", "out");
    const r = await service.createRecipe(context(), {
      ...recipeInput,
      ingredients: [
        { name: "Enough", quantity: 2, unit: "kg", inventoryItemId: ids[0] },
        { name: "Mismatch", quantity: 2, unit: "g", inventoryItemId: ids[0] },
        { name: "Coarse", quantity: 1, unit: "kg", inventoryItemId: ids[1] },
        { name: "Unlinked", quantity: 1, unit: "kg" },
        { name: "None", quantity: 1, unit: "kg", inventoryItemId: ids[2] },
      ],
    });
    expect(r.availability.ingredients.map((x) => x.state)).toEqual([
      "sufficient",
      "unknown",
      "unknown",
      "unknown",
      "missing",
    ]);
    const m = await service.createMeal(context(), {
      title: "Stock stays",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
    });
    await service.respond(context(), m.id, {
      response: "yes",
      announcementVersion: 1,
      expectedResponseVersion: 0,
    });
    expect(
      (
        await env.DB.prepare("SELECT quantity FROM inventory_items WHERE id=?")
          .bind(ids[0])
          .first<{ quantity: number }>()
      )?.quantity,
    ).toBe(3);
  });
  it("preserves unchanged explicit snapshots and invalidates only actual refreshed dish content", async () => {
    const { service } = fixture();
    const r = await service.createRecipe(context(), recipeInput);
    let m = await service.createMeal(context(), {
      title: "Snapshot",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
    });
    await service.respond(context(), m.id, {
      response: "yes",
      announcementVersion: 1,
      expectedResponseVersion: 0,
    });
    m = await service.updateMeal(context(1), m.id, { recipeIds: [r.id] });
    expect(m.announcementVersion).toBe(1);
    expect(m.myAttendance?.response).toBe("yes");
    await service.updateRecipe(context(1), r.id, { name: "Dal with rice" });
    m = await service.updateMeal(context(2), m.id, { notes: "A note" });
    expect(m.recipes[0].name).toBe("Dal");
    expect(m.announcementVersion).toBe(1);
    m = await service.updateMeal(context(3), m.id, { recipeIds: [r.id] });
    expect(m.recipes[0].name).toBe("Dal with rice");
    expect(m.announcementVersion).toBe(2);
    expect(m.myAttendance?.response).toBe("pending");
  });
  it("replays accepted commands after deadline and after archive without another audit", async () => {
    const { service, setNow } = fixture();
    const r = await service.createRecipe(context(), recipeInput);
    const command = context();
    const input = {
      title: "Replay",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
    };
    const first = await service.createMeal(command, input);
    const archive = context(1);
    await service.archiveRecipe(archive, r.id);
    expect((await service.archiveRecipe(archive, r.id)).version).toBe(2);
    setNow("2090-01-01T13:00:00.000Z");
    expect(await service.createMeal(command, input)).toEqual(first);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_events WHERE operation_id=?",
        )
          .bind(command.operationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("bounds reminders by effective pending, current announcement, active membership and cooking cutoff", async () => {
    const { service, setNow } = fixture();
    const r = await service.createRecipe(context(), recipeInput);
    const m = await service.createMeal(context(), {
      title: "Reminder",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
      reminderMinutesBefore: 60,
    });
    const eligible = (ann = 1, now = "2090-01-01T11:00:00.000Z") =>
      isMealReminderEligible(env.DB, "home", m.id, ann, "local-owner", now);
    expect(await eligible(1, "2090-01-01T10:59:59.999Z")).toBe(false);
    expect(await eligible()).toBe(true);
    expect(await eligible(1, "2090-01-01T12:00:00.000Z")).toBe(false);
    const due = await listDueMealReminders(
      env.DB,
      "home",
      "2090-01-01T11:00:00.000Z",
    );
    expect(due.find((x) => x.mealId === m.id)).toMatchObject({
      recipeNames: ["Dal"],
      announcementVersion: 1,
      timezone: "Asia/Kolkata",
    });
    await service.respond(context(), m.id, {
      response: "yes",
      announcementVersion: 1,
      expectedResponseVersion: 0,
    });
    expect(await eligible()).toBe(false);
    await service.updateMeal(context(1), m.id, {
      cookingAt: "2090-01-01T12:30:00Z",
    });
    expect(await eligible()).toBe(false);
    expect(await eligible(2, "2090-01-01T11:30:00.000Z")).toBe(true);
    await env.DB.prepare(
      "INSERT INTO members (id,household_id,display_name,role,created_at,updated_at) VALUES ('backup-cooking-owner','home','Backup','owner','2090-01-01','2090-01-01')",
    ).run();
    await env.DB.prepare(
      "UPDATE members SET role='viewer' WHERE id='local-owner'",
    ).run();
    expect(await eligible(2, "2090-01-01T11:30:00.000Z")).toBe(false);
    await env.DB.prepare(
      "UPDATE members SET role='owner' WHERE id='local-owner'",
    ).run();
    await service.updateMeal(context(2), m.id, { status: "cancelled" });
    expect(await eligible(2, "2090-01-01T11:30:00.000Z")).toBe(false);
    expect((await service.getMeal("home", m.id, "local-owner")).status).toBe(
      "cancelled",
    );
    await expect(
      service.respond(context(), m.id, {
        response: "no",
        announcementVersion: 2,
        expectedResponseVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 400 });
    setNow("2090-01-01T14:00:00.000Z");
    expect((await service.getMeal("home", m.id, "local-owner")).id).toBe(m.id);
  });
  it("rejects cross-household IDs and globally reused legacy operations", async () => {
    const { service } = fixture();
    const now = "2090-01-01";
    await env.DB.prepare(
      "INSERT INTO households (id,name,timezone,created_at,updated_at) VALUES ('foreign-cooking','Foreign','UTC',?,?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO recipes (id,household_id,name,servings,ingredients_json,created_at,updated_at) VALUES ('foreign-dish','foreign-cooking','Secret',2,'[]',?,?)",
    )
      .bind(now, now)
      .run();
    await expect(
      service.createMeal(context(), {
        title: "Foreign",
        recipeIds: ["foreign-dish"],
        cookingAt: "2090-01-01T12:00:00Z",
      }),
    ).rejects.toMatchObject({ status: 404 });
    const op = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO processed_operations (household_id,operation_id,entity_type,entity_id,result_json,processed_at) VALUES ('home',?,'inventory_item','old','{}',?)",
    )
      .bind(op, now)
      .run();
    await expect(
      service.createRecipe(context(undefined, op), recipeInput),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("excludes departed participants while preserving their stored historical answer", async () => {
    const { service } = fixture();
    const r = await service.createRecipe(context(), recipeInput);
    const m = await service.createMeal(context(), {
      title: "Membership",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
    });
    await env.DB.prepare(
      "INSERT INTO members (id,household_id,display_name,role,created_at,updated_at) VALUES ('departed-cook','home','Departed','member','2090-01-01','2090-01-01')",
    ).run();
    const memberContext = { ...context(), actorId: "departed-cook" };
    await service.respond(memberContext, m.id, {
      response: "yes",
      announcementVersion: 1,
      expectedResponseVersion: 0,
    });
    const before = await service.getMeal("home", m.id, "local-owner");
    expect(before.attendance.counts.yes).toBe(1);
    await env.DB.prepare(
      "UPDATE members SET archived_at='2090-01-01' WHERE id='departed-cook'",
    ).run();
    const after = await service.getMeal("home", m.id, "local-owner");
    expect(after.attendance.counts.total).toBe(
      before.attendance.counts.total - 1,
    );
    expect(after.attendance.counts.yes).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT response FROM meal_attendance WHERE meal_id=? AND member_id='departed-cook'",
        )
          .bind(m.id)
          .first<{ response: string }>()
      )?.response,
    ).toBe("yes");
    await expect(
      service.respond({ ...context(), actorId: "departed-cook" }, m.id, {
        response: "no",
        announcementVersion: 1,
        expectedResponseVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("retains historical accepted answers in audit after a response changes", async () => {
    const { service } = fixture();
    const r = await service.createRecipe(context(), recipeInput);
    const m = await service.createMeal(context(), {
      title: "Answer history",
      recipeIds: [r.id],
      cookingAt: "2090-01-01T12:00:00Z",
    });
    await service.respond(context(), m.id, {
      response: "yes",
      announcementVersion: 1,
      expectedResponseVersion: 0,
    });
    await service.respond(context(), m.id, {
      response: "no",
      announcementVersion: 1,
      expectedResponseVersion: 1,
    });
    const rows = await env.DB.prepare(
      "SELECT changes_json FROM audit_events WHERE entity_type='meal_attendance' AND entity_id=? ORDER BY sequence",
    )
      .bind(m.id)
      .all<{ changes_json: string }>();
    expect(rows.results.map((row) => JSON.parse(row.changes_json))).toEqual([
      expect.arrayContaining([
        expect.objectContaining({
          field: "attendance",
          after: expect.objectContaining({
            response: "yes",
            announcementVersion: 1,
            responseVersion: 1,
          }),
        }),
      ]),
      expect.arrayContaining([
        expect.objectContaining({
          field: "attendance",
          after: expect.objectContaining({
            response: "no",
            announcementVersion: 1,
            responseVersion: 2,
          }),
        }),
      ]),
    ]);
  });
  it("rejects claims in lifecycle command bodies", async () => {
    const r = await cookingApi("/recipes", "POST", recipeInput);
    const body = await r.json<{ data: { recipe: { id: string } } }>();
    expect(
      (
        await cookingApi(
          `/recipes/${body.data.recipe.id}`,
          "DELETE",
          { actorId: "spoof" },
          { version: 1 },
        )
      ).status,
    ).toBe(400);
  });
});
describe("household time", () => {
  it("uses Kolkata calendar boundaries independently of runtime timezone", () => {
    expect(menuBounds("2090-01-01", "2090-01-02", "Asia/Kolkata")).toEqual({
      from: "2089-12-31T18:30:00.000Z",
      to: "2090-01-01T18:30:00.000Z",
    });
    expect(cookingInstant("2090-01-01T18:30", "Asia/Kolkata")).toBe(
      "2090-01-01T13:00:00.000Z",
    );
    expect(() =>
      cookingInstant("2090-02-30T12:00:00Z", "Asia/Kolkata"),
    ).toThrow();
  });
  it("returns validation errors for malformed local clock values", () => {
    expect(() =>
      cookingInstant("2090-01-01T99:99", "Asia/Kolkata"),
    ).toThrowError(ValidationError);
  });
  it("handles DST days and refuses missing/ambiguous local form times", () => {
    expect(menuBounds("2026-03-08", "2026-03-09", "America/New_York")).toEqual({
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-09T04:00:00.000Z",
    });
    expect(() =>
      cookingInstant("2026-03-08T02:30", "America/New_York"),
    ).toThrow();
    expect(() =>
      cookingInstant("2026-11-01T01:30", "America/New_York"),
    ).toThrow();
    expect(
      cookingInstant("2026-11-01T01:30:00-04:00", "America/New_York"),
    ).toBe("2026-11-01T05:30:00.000Z");
  });
});
