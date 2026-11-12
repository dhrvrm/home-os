import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type {
  MealReminderCandidate,
  MealReminderSource,
} from "../src/meals/model";
import {
  isMealReminderEligible,
  listDueMealReminders,
} from "../src/meals/reminders";
import { NotificationRepository } from "../src/notifications/d1-repository";
import { runNotificationTick } from "../src/notifications/scheduled";
import type { PushFetch } from "../src/notifications/push";
import {
  pushFixture,
  resetNotifications,
  seedNotificationMeal,
  seedNotificationMember,
} from "./notification-fixtures";

const now = "2026-11-12T10:00:00.000Z";
let candidate: MealReminderCandidate;
let eligible: boolean;
const source: MealReminderSource = {
  listDueMealReminders: async () => [candidate],
  isMealReminderEligible: async (
    _household,
    mealId,
    version,
    memberId,
    instant,
  ) =>
    eligible &&
    mealId === candidate.mealId &&
    version === candidate.announcementVersion &&
    memberId === candidate.memberId &&
    candidate.reminderAt <= instant &&
    instant < candidate.cookingAt,
};

beforeEach(async () => {
  await resetNotifications();
  await seedNotificationMember();
  candidate = await seedNotificationMeal(now);
  eligible = true;
});

async function enabledPush() {
  const fixture = await pushFixture();
  const repo = new NotificationRepository(env.DB, "home");
  const hash = await seedNotificationMember();
  await repo.setPreferences(
    "local-owner",
    { mealReminders: true, pushEnabled: true },
    now,
  );
  await repo.registerSubscription(
    "local-owner",
    {
      tokenHash: hash,
      expiresAt: "2099-01-01T00:00:00.000Z",
      credentialVersion: 1,
    },
    fixture.subscription,
    await (
      await import("../src/auth/crypto")
    ).digest(fixture.subscription.endpoint),
    now,
  );
  return { ...fixture, repo, hash };
}
async function count(
  table:
    | "notifications"
    | "notification_reminders"
    | "notification_subscriptions"
    | "notification_deliveries",
) {
  return env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>(
    "count",
  );
}
async function delivery() {
  return env.DB.prepare(
    "SELECT id, state, attempt_count, claim_token, next_attempt_at FROM notification_deliveries",
  ).first<{
    id: string;
    state: string;
    attempt_count: number;
    claim_token: string | null;
    next_attempt_at: string;
  }>();
}

describe("bounded notification scheduling", () => {
  it("eventually visits every unanswered recipient beyond the first bounded meal page", async () => {
    const statements = Array.from({ length: 205 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES (?, 'home', ?, 'member', ?, ?)",
      ).bind(
        `notice-fair-${index.toString().padStart(3, "0")}`,
        `Member ${index}`,
        now,
        now,
      ),
    );
    for (let start = 0; start < statements.length; start += 50)
      await env.DB.batch(statements.slice(start, start + 50));
    const realSource: MealReminderSource = {
      listDueMealReminders: (household, instant, limit, after) =>
        listDueMealReminders(env.DB, household, instant, limit, after),
      isMealReminderEligible: (household, meal, version, member, instant) =>
        isMealReminderEligible(
          env.DB,
          household,
          meal,
          version,
          member,
          instant,
        ),
    };
    const perTick: number[] = [];
    let previous = 0;
    for (let tick = 0; tick < 6; tick++) {
      await runNotificationTick(env, realSource, now);
      const total = (await count("notifications"))!;
      perTick.push(total - previous);
      previous = total;
    }
    expect(await count("notifications")).toBe(206);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(50);
    expect(await count("notification_reminders")).toBe(206);

    // A new recipient ordered before the saved cursor is found after wrapping,
    // and revisiting existing unanswered people must not duplicate their inboxes.
    await env.DB.prepare(
      "INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES ('notice-000-late', 'home', 'Late joiner', 'member', ?, ?)",
    )
      .bind(now, now)
      .run();
    for (let tick = 0; tick < 6; tick++)
      await runNotificationTick(env, realSource, now);
    expect(await count("notifications")).toBe(207);
    expect(await count("notification_reminders")).toBe(207);
  });

  it("creates one logical inbox reminder without push credentials or a subscription", async () => {
    const settings = {
      ...env,
      HOMEOS_VAPID_PUBLIC_KEY: undefined,
      HOMEOS_VAPID_PRIVATE_KEY: undefined,
    };
    const first = await runNotificationTick(settings, source, now);
    const second = await runNotificationTick(settings, source, now);
    expect(first.attempted + second.attempted).toBe(0);
    expect(await count("notifications")).toBe(1);
    expect(await count("notification_reminders")).toBe(1);
    expect(await count("notification_deliveries")).toBe(0);
    const list = await new NotificationRepository(env.DB, "home").list(
      "local-owner",
      now,
    );
    expect(list.unreadCount).toBe(1);
    expect(list.notifications[0]).toMatchObject({
      mealId: candidate.mealId,
      announcementVersion: 1,
      url: "/?view=menu&meal=notice-meal",
    });
  });

  it("deduplicates overlapping ticks, sends encrypted content and keeps provider acceptance distinct from reading", async () => {
    const fixture = await enabledPush();
    let calls = 0;
    const fetcher: PushFetch = async (_url, request) => {
      calls++;
      expect(new Headers(request.headers).get("Content-Encoding")).toBe(
        "aes128gcm",
      );
      expect(new Headers(request.headers).get("Topic")).toMatch(
        /^[A-Za-z0-9_-]{32}$/,
      );
      return new Response(null, { status: 201 });
    };
    await Promise.all([
      runNotificationTick(fixture.settings, source, now, { fetcher }),
      runNotificationTick(fixture.settings, source, now, { fetcher }),
    ]);
    await runNotificationTick(fixture.settings, source, now, { fetcher });
    expect(calls).toBe(1);
    expect(await count("notifications")).toBe(1);
    expect(await count("notification_reminders")).toBe(1);
    expect(await count("notification_deliveries")).toBe(1);
    expect(await delivery()).toMatchObject({
      state: "accepted",
      attempt_count: 1,
      claim_token: null,
    });
    expect((await fixture.repo.list("local-owner", now)).unreadCount).toBe(1);
  });

  it("fences late completion and endpoint retirement after a different lease owner takes over", async () => {
    const fixture = await enabledPush();
    await runNotificationTick(
      { ...fixture.settings, HOMEOS_VAPID_PRIVATE_KEY: undefined },
      source,
      now,
    );
    const row = (await delivery())!;
    const sub = await env.DB.prepare(
      "SELECT id FROM notification_subscriptions",
    ).first<string>("id");
    const subscription = (await fixture.repo.subscription(
      sub!,
      "local-owner",
    ))!;
    const firstClaimAt = "2026-11-12T10:00:01.000Z";
    expect(await fixture.repo.claim(row.id, firstClaimAt, "claim-A")).toBe(
      true,
    );
    expect(await fixture.repo.claim(row.id, firstClaimAt, "claim-other")).toBe(
      false,
    );
    const later = "2026-11-12T10:00:31.000Z";
    expect(await fixture.repo.claim(row.id, later, "claim-B")).toBe(true);
    expect(
      await fixture.repo.retireClaimedSubscription(
        sub!,
        "local-owner",
        row.id,
        "claim-A",
        subscription,
      ),
    ).toBe(false);
    expect(
      await fixture.repo.settle(row.id, "claim-A", "failed", later, later, 400),
    ).toBe(false);
    expect(
      await fixture.repo.settle(
        row.id,
        "claim-B",
        "accepted",
        later,
        later,
        201,
      ),
    ).toBe(true);
    expect(
      await fixture.repo.settle(
        row.id,
        "claim-A",
        "pending",
        later,
        later,
        503,
      ),
    ).toBe(false);
    expect(await delivery()).toMatchObject({
      state: "accepted",
      attempt_count: 2,
    });
    expect(await count("notification_subscriptions")).toBe(1);
  });

  it("does not retire a newly rotated subscription when a previous endpoint rejects an in-flight send", async () => {
    const fixture = await enabledPush();
    await runNotificationTick(
      { ...fixture.settings, HOMEOS_VAPID_PRIVATE_KEY: undefined },
      source,
      now,
    );
    const row = (await delivery())!;
    const sub = await env.DB.prepare(
      "SELECT id FROM notification_subscriptions",
    ).first<string>("id");
    const original = (await fixture.repo.subscription(sub!, "local-owner"))!;
    expect(
      await fixture.repo.claim(
        row.id,
        "2026-11-12T10:00:01.000Z",
        "claim-original-endpoint",
      ),
    ).toBe(true);
    const rotated = await pushFixture();
    await fixture.repo.registerSubscription(
      "local-owner",
      {
        tokenHash: fixture.hash,
        expiresAt: "2099-01-01T00:00:00.000Z",
        credentialVersion: 1,
      },
      { ...rotated.subscription, endpoint: fixture.subscription.endpoint },
      await (
        await import("../src/auth/crypto")
      ).digest(fixture.subscription.endpoint),
      now,
    );
    expect(
      await fixture.repo.retireClaimedSubscription(
        sub!,
        "local-owner",
        row.id,
        "claim-original-endpoint",
        original,
      ),
    ).toBe(false);
    expect(await count("notification_subscriptions")).toBe(1);
    expect((await fixture.repo.subscription(sub!, "local-owner"))?.p256dh).toBe(
      rotated.subscription.keys.p256dh,
    );
  });

  it("rechecks changed meal attendance immediately before network dispatch", async () => {
    const fixture = await enabledPush();
    let checks = 0;
    let sends = 0;
    const changedSource: MealReminderSource = {
      ...source,
      isMealReminderEligible: async (...args) =>
        ++checks < 3 && source.isMealReminderEligible(...args),
    };
    await runNotificationTick(fixture.settings, changedSource, now, {
      fetcher: async () => {
        sends++;
        return new Response(null, { status: 201 });
      },
    });
    expect(sends).toBe(0);
    expect(checks).toBe(3);
    expect(await delivery()).toMatchObject({ state: "suppressed" });
  });

  it("suppresses an old announcement after rescheduling and creates one new logical reminder", async () => {
    const fixture = await enabledPush();
    await runNotificationTick(fixture.settings, source, now, {
      fetcher: async () => new Response(null, { status: 503 }),
    });
    candidate = { ...candidate, announcementVersion: 2 };
    await runNotificationTick(
      fixture.settings,
      source,
      "2026-11-12T10:01:00.000Z",
      { fetcher: async () => new Response(null, { status: 201 }) },
    );
    const rows = (
      await env.DB.prepare(
        "SELECT state FROM notification_deliveries ORDER BY state",
      ).all<{ state: string }>()
    ).results;
    expect(rows.map((row) => row.state)).toEqual(["accepted", "suppressed"]);
    expect(await count("notifications")).toBe(2);
  });

  it("retries eligible deliveries independently of the bounded creation page", async () => {
    const fixture = await enabledPush();
    await runNotificationTick(fixture.settings, source, now, {
      fetcher: async () => new Response(null, { status: 503 }),
    });
    const pagedSource = { ...source, listDueMealReminders: async () => [] };
    await runNotificationTick(
      fixture.settings,
      pagedSource,
      "2026-11-12T10:01:00.000Z",
      {
        fetcher: async () => new Response(null, { status: 201 }),
      },
    );
    expect(await delivery()).toMatchObject({
      state: "accepted",
      attempt_count: 2,
    });
  });

  it("retries temporary failures with a stable topic, at most five attempts and only before cooking", async () => {
    const fixture = await enabledPush();
    const topics: string[] = [];
    const fetcher: PushFetch = async (_url, request) => {
      topics.push(new Headers(request.headers).get("Topic")!);
      return new Response(null, { status: 429 });
    };
    for (const minute of [0, 1, 3, 7, 15, 30]) {
      await runNotificationTick(
        fixture.settings,
        source,
        new Date(Date.parse(now) + minute * 60_000).toISOString(),
        { fetcher },
      );
    }
    expect(topics).toHaveLength(5);
    expect(new Set(topics).size).toBe(1);
    expect(await delivery()).toMatchObject({
      state: "failed",
      attempt_count: 5,
    });
  });

  it("ends retry scheduling when there is insufficient time before cooking", async () => {
    const fixture = await enabledPush();
    candidate = { ...candidate, cookingAt: "2026-11-12T10:00:20.000Z" };
    await runNotificationTick(fixture.settings, source, now, {
      fetcher: async () => new Response(null, { status: 503 }),
    });
    expect(await delivery()).toMatchObject({
      state: "failed",
      attempt_count: 1,
    });
  });

  it("retires 404/410 endpoints and makes other 4xx or redirects terminal", async () => {
    for (const status of [404, 410, 400, 403, 302]) {
      await resetNotifications();
      await seedNotificationMember();
      candidate = await seedNotificationMeal(now);
      const fixture = await enabledPush();
      await runNotificationTick(fixture.settings, source, now, {
        fetcher: async () => new Response(null, { status }),
      });
      if (status === 404 || status === 410) {
        expect(await count("notification_subscriptions")).toBe(0);
        expect(await count("notification_deliveries")).toBe(0);
      } else
        expect(await delivery()).toMatchObject({
          state: "failed",
          attempt_count: 1,
        });
    }
  });

  it("suppresses preference opt-out, cancellation, an answered meal and exact cooking deadline before retry", async () => {
    for (const changed of [
      "preferences",
      "cancelled",
      "answered",
      "deadline",
    ] as const) {
      await resetNotifications();
      await seedNotificationMember();
      candidate = await seedNotificationMeal(now);
      eligible = true;
      const fixture = await enabledPush();
      let sends = 0;
      const fetcher: PushFetch = async () => {
        sends++;
        return new Response(null, { status: 503 });
      };
      await runNotificationTick(fixture.settings, source, now, { fetcher });
      if (changed === "preferences")
        await fixture.repo.setPreferences(
          "local-owner",
          { mealReminders: false, pushEnabled: false },
          now,
        );
      if (changed === "cancelled" || changed === "answered") eligible = false;
      await runNotificationTick(
        fixture.settings,
        source,
        changed === "deadline"
          ? candidate.cookingAt
          : "2026-11-12T10:01:00.000Z",
        { fetcher },
      );
      expect(sends).toBe(1);
      expect(await delivery()).toMatchObject({ state: "suppressed" });
    }
  });

  it("stops future sends after session revocation, expiry, credential replacement or member departure", async () => {
    for (const changed of [
      "revoked",
      "expired",
      "credentials",
      "archived",
    ] as const) {
      await resetNotifications();
      await seedNotificationMember();
      candidate = await seedNotificationMeal(now);
      eligible = true;
      const fixture = await enabledPush();
      let sends = 0;
      const fetcher: PushFetch = async () => {
        sends++;
        return new Response(null, { status: 503 });
      };
      await runNotificationTick(fixture.settings, source, now, { fetcher });
      if (changed === "revoked")
        await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
          .bind(fixture.hash)
          .run();
      if (changed === "expired")
        await env.DB.prepare(
          "UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?",
        )
          .bind("2026-11-12T10:00:30.000Z", fixture.hash)
          .run();
      if (changed === "credentials")
        await env.DB.prepare(
          "UPDATE auth_accounts SET credential_version = 2 WHERE member_id = 'local-owner'",
        ).run();
      if (changed === "archived") {
        await seedNotificationMember(
          "notice-backup-owner",
          "owner",
          "f".repeat(64),
        );
        await env.DB.prepare(
          "UPDATE members SET archived_at = ? WHERE id = 'local-owner'",
        )
          .bind(now)
          .run();
      }
      await runNotificationTick(
        fixture.settings,
        source,
        "2026-11-12T10:01:00.000Z",
        { fetcher },
      );
      expect(sends).toBe(1);
      expect(await count("notification_subscriptions")).toBe(0);
    }
  });

  it("creates no inbox when meal reminders are disabled and rejects malformed stored receiving keys", async () => {
    const fixture = await enabledPush();
    await fixture.repo.setPreferences(
      "local-owner",
      { mealReminders: false, pushEnabled: true },
      now,
    );
    await runNotificationTick(fixture.settings, source, now, {
      fetcher: async () => {
        throw new Error("not eligible");
      },
    });
    expect(await count("notifications")).toBe(0);
    await fixture.repo.setPreferences(
      "local-owner",
      { mealReminders: true, pushEnabled: true },
      now,
    );
    await env.DB.prepare(
      "UPDATE notification_subscriptions SET auth = 'invalid'",
    ).run();
    const result = await runNotificationTick(fixture.settings, source, now, {
      fetcher: async () => {
        throw new Error("must retire invalid keys before dispatch");
      },
    });
    expect(result.retired).toBe(1);
    expect(result.attempted).toBe(0);
    expect(await count("notification_subscriptions")).toBe(0);
  });

  it("bounds each tick to twenty provider attempts with at most four concurrent requests", async () => {
    const fixture = await enabledPush();
    const hash = await seedNotificationMember();
    const members = ["local-owner"];
    // Distinct valid sessions are required by the real subscription foreign key.
    for (let index = 0; index < 24; index++) {
      const memberId = `notice-member-${index}`;
      const token = index.toString(16).padStart(64, "0");
      const session = await seedNotificationMember(memberId, "member", token);
      await fixture.repo.setPreferences(
        memberId,
        { mealReminders: true, pushEnabled: true },
        now,
      );
      const native = {
        ...fixture.subscription,
        endpoint: `https://fcm.googleapis.com/fcm/send/fixture-${index}`,
      };
      await fixture.repo.registerSubscription(
        memberId,
        {
          tokenHash: session,
          expiresAt: "2099-01-01T00:00:00.000Z",
          credentialVersion: 1,
        },
        native,
        `${hash}-${index}`,
        now,
      );
      members.push(memberId);
    }
    const candidates = members.map((memberId) => ({ ...candidate, memberId }));
    const manySource: MealReminderSource = {
      listDueMealReminders: async () => candidates,
      isMealReminderEligible: async () => true,
    };
    let active = 0;
    let peak = 0;
    let sends = 0;
    const fetcher: PushFetch = async () => {
      sends++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response(null, { status: 201 });
    };
    await runNotificationTick(fixture.settings as Env, manySource, now, {
      fetcher,
    });
    expect(sends).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    expect(await count("notifications")).toBe(25);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_deliveries WHERE state = 'pending'",
      ).first("count"),
    ).toBe(5);
  });
});
