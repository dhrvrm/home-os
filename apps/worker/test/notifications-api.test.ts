import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { currentDeviceGrant, protectHousehold } from "../src/auth/session";
import type { Env } from "../src/env";
import { failure } from "../src/http/envelope";
import type { MealReminderSource } from "../src/meals/model";
import { HomeOSError, ValidationError } from "../src/platform/errors";
import { NotificationRepository } from "../src/notifications/d1-repository";
import { createNotificationRoutes } from "../src/notifications/routes";
import {
  pushFixture,
  resetNotifications,
  seedNotificationMeal,
  seedNotificationMember,
} from "./notification-fixtures";

const origin = "https://home-os.test";
let eligible = true;
const source: MealReminderSource = {
  listDueMealReminders: async () => [],
  isMealReminderEligible: async () => eligible,
};
const app = new Hono<{ Bindings: Env }>();
app.use("/api/v1/*", protectHousehold);
app.route(
  "/api/v1",
  createNotificationRoutes(() => source),
);
app.get("/api/v1/notice-fixture-grant", (context) =>
  context.json({ expiresAt: currentDeviceGrant(context).expiresAt }),
);
app.onError((error, context) => {
  if (error instanceof HomeOSError)
    return failure(
      context,
      {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError ? { field: error.field } : {}),
      },
      error.status as ContentfulStatusCode,
    );
  throw error;
});

function send(
  path: string,
  method = "GET",
  body?: unknown,
  settings: Env = env,
  memberId = "local-owner",
  token = "a".repeat(64),
  extra: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`${origin}/api/v1/notifications${path}`, {
      method,
      headers: {
        Cookie: `homeos_session=${token}`,
        Origin: origin,
        "Content-Type": "application/json",
        "X-HomeOS-Member": memberId,
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    settings,
  );
}

beforeEach(async () => {
  await resetNotifications();
  await seedNotificationMember();
  eligible = true;
});

describe("personal notification API", () => {
  it("keeps inbox and default preferences available without sender secrets", async () => {
    const settings = {
      ...env,
      HOMEOS_VAPID_PUBLIC_KEY: undefined,
      HOMEOS_VAPID_PRIVATE_KEY: undefined,
    };
    expect(
      await (await send("/config", "GET", undefined, settings)).json(),
    ).toEqual({ data: { pushAvailable: false, publicKey: null }, error: null });
    expect(await (await send("/preferences")).json()).toEqual({
      data: { preferences: { mealReminders: true, pushEnabled: false } },
      error: null,
    });
    expect(await (await send("")).json()).toEqual({
      data: { notifications: [], unreadCount: 0 },
      error: null,
    });
    expect(
      (await send("/subscriptions/current", "PUT", {}, settings)).status,
    ).toBe(503);
  });

  it("admits viewer personal setters and rejects foreign inbox IDs, claimed actors, and unsafe requests", async () => {
    await seedNotificationMember("notice-viewer", "viewer", "b".repeat(64));
    const repo = new NotificationRepository(env.DB, "home");
    const candidate = await seedNotificationMeal();
    await repo.createReminder(
      "notice-own",
      candidate,
      new Date().toISOString(),
    );
    const preferences = await send(
      "/preferences",
      "PUT",
      { mealReminders: false, pushEnabled: false },
      env,
      "notice-viewer",
      "b".repeat(64),
    );
    expect(preferences.status).toBe(200);
    expect(
      (
        await send(
          "/notice-own",
          "PATCH",
          { read: true },
          env,
          "notice-viewer",
          "b".repeat(64),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send("/notice-own", "PATCH", {
          read: true,
          memberId: "local-owner",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          "/notice-own",
          "PATCH",
          { read: true },
          env,
          "local-owner",
          "a".repeat(64),
          { Origin: "https://attacker.test" },
        )
      ).status,
    ).toBe(403);
    const result = (await (
      await send("/notice-own", "PATCH", { read: true })
    ).json()) as { data: { notification: { readAt: string } } };
    expect(result.data.notification.readAt).toBeTruthy();
    expect(
      await (await send("/notice-own", "PATCH", { read: true })).json(),
    ).toEqual(result);
    expect(
      (await send("/notice-own", "PATCH", { read: true }, env, "wrong-member"))
        .status,
    ).toBe(409);
  });

  it("bounds streamed JSON without a content-length header and never reflects receiving secrets in validation failures", async () => {
    const fixture = await pushFixture();
    const oversized = new TextEncoder().encode(
      JSON.stringify({ endpoint: "s".repeat(70_000) }),
    );
    const response = await app.fetch(
      new Request(`${origin}/api/v1/notifications/subscriptions/current`, {
        method: "PUT",
        headers: {
          Cookie: `homeos_session=${"a".repeat(64)}`,
          Origin: origin,
          "Content-Type": "application/json",
          "X-HomeOS-Member": "local-owner",
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
      }),
      fixture.settings,
    );
    expect(response.status).toBe(400);
    const rejected = await send(
      "/subscriptions/current",
      "PUT",
      {
        ...fixture.subscription,
        endpoint: "https://private-secret.example.test/a",
      },
      fixture.settings,
    );
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain(
      "private-secret",
    );
  });

  it("redacts subscriptions and binds re-registration, retirement, and browser account switch to the current session", async () => {
    const fixture = await pushFixture();
    const first = await send(
      "/subscriptions/current",
      "PUT",
      fixture.subscription,
      fixture.settings,
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { subscription: { id: string } };
    };
    const safeBody = JSON.stringify(firstBody);
    for (const confidential of [
      fixture.subscription.endpoint,
      fixture.subscription.keys.auth,
      fixture.subscription.keys.p256dh,
      "session_hash",
      "endpoint_hash",
      "privateKey",
    ])
      expect(safeBody).not.toContain(confidential);
    const same = (await (
      await send(
        "/subscriptions/current",
        "PUT",
        fixture.subscription,
        fixture.settings,
      )
    ).json()) as typeof firstBody;
    expect(same.data.subscription.id).toBe(firstBody.data.subscription.id);
    const rotated = await pushFixture();
    expect(
      (
        await send(
          "/subscriptions/current",
          "PUT",
          { ...rotated.subscription, endpoint: fixture.subscription.endpoint },
          fixture.settings,
        )
      ).status,
    ).toBe(200);
    // Re-establish the browser permission used below after a legitimate same-session key rotation.
    expect(
      (
        await send(
          "/subscriptions/current",
          "PUT",
          fixture.subscription,
          fixture.settings,
        )
      ).status,
    ).toBe(200);
    await seedNotificationMember("notice-next", "member", "c".repeat(64));
    expect(
      (
        await send(
          "/subscriptions/current",
          "PUT",
          fixture.subscription,
          fixture.settings,
          "notice-next",
          "c".repeat(64),
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await send("/subscriptions/current", "GET", undefined, fixture.settings)
      ).json(),
    ).toEqual({ data: { subscription: { enabled: false } }, error: null });
    expect(
      (
        await send(
          "/subscriptions/current",
          "DELETE",
          undefined,
          fixture.settings,
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_subscriptions WHERE member_id = 'notice-next'",
      ).first("count"),
    ).toBe(1);
    expect(
      (
        await send(
          "/subscriptions/current",
          "DELETE",
          undefined,
          fixture.settings,
          "notice-next",
          "c".repeat(64),
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_subscriptions",
      ).first("count"),
    ).toBe(0);
  });

  it("revalidates intended recipient, exact session, current meal and preferences before returning a private preview", async () => {
    const fixture = await pushFixture();
    await send(
      "/subscriptions/current",
      "PUT",
      fixture.subscription,
      fixture.settings,
    );
    await send("/preferences", "PUT", {
      mealReminders: true,
      pushEnabled: true,
    });
    const candidate = await seedNotificationMeal();
    await new NotificationRepository(env.DB, "home").createReminder(
      "notice-preview",
      candidate,
      new Date().toISOString(),
    );
    expect((await send("/notice-preview/delivery-check")).status).toBe(200);
    expect(
      (
        await send(
          "/notice-preview/delivery-check",
          "GET",
          undefined,
          env,
          "wrong-member",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await send(
          "/notice-preview/delivery-check",
          "GET",
          undefined,
          env,
          "local-owner",
          "a".repeat(64),
          { "X-HomeOS-Member": "" },
        )
      ).status,
    ).toBe(409);
    eligible = false;
    expect((await send("/notice-preview/delivery-check")).status).toBe(404);
    eligible = true;
    await send("/preferences", "PUT", {
      mealReminders: true,
      pushEnabled: false,
    });
    expect((await send("/notice-preview/delivery-check")).status).toBe(404);
    await send("/preferences", "PUT", {
      mealReminders: true,
      pushEnabled: true,
    });
    await send("/subscriptions/current", "DELETE");
    expect((await send("/notice-preview/delivery-check")).status).toBe(404);
  });

  it("caps retained history without recreating an entry whose seven-day marker remains", async () => {
    const candidate = await seedNotificationMeal();
    const repo = new NotificationRepository(env.DB, "home");
    const now = new Date().toISOString();
    for (let index = 0; index < 55; index++) {
      await env.DB.prepare(
        `INSERT INTO notifications (id, household_id, member_id, title, body, meal_id, announcement_version, url, created_at)
        VALUES (?, 'home', 'local-owner', 'Meal', 'Question', 'notice-meal', 1, '/?view=menu&meal=notice-meal', ?)`,
      )
        .bind(
          `notice-${index.toString().padStart(3, "0")}`,
          new Date(Date.parse(now) - index * 1000).toISOString(),
        )
        .run();
    }
    await env.DB.prepare(
      "UPDATE notifications SET created_at = ? WHERE id = 'notice-054'",
    )
      .bind(new Date(Date.parse(now) - 15 * 86_400_000).toISOString())
      .run();
    await repo.createReminder("notice-dedup", candidate, now);
    await env.DB.prepare(
      "DELETE FROM notifications WHERE id = 'notice-dedup'",
    ).run();
    await repo.prune(now);
    await repo.createReminder("notice-dedup", candidate, now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM notifications WHERE id = 'notice-dedup'",
      ).first("COUNT(*)"),
    ).toBe(0);
    expect((await repo.list("local-owner", now)).notifications).toHaveLength(
      50,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM notifications").first(
        "COUNT(*)",
      ),
    ).toBe(50);
    await repo.prune(new Date(Date.parse(now) + 15 * 86_400_000).toISOString());
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM notifications").first(
        "COUNT(*)",
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM notification_reminders").first(
        "COUNT(*)",
      ),
    ).toBe(0);
  });
});
