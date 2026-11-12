import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const now = "2026-11-12T12:00:00.000Z";

describe("household planning storage", () => {
  it("adds household planning tables without replacing the established owner or household", async () => {
    expect(await env.DB.prepare("SELECT timezone FROM households WHERE id = 'home'").first()).toEqual({ timezone: "Asia/Kolkata" });
    expect(await env.DB.prepare("SELECT role FROM members WHERE id = 'local-owner'").first()).toEqual({ role: "owner" });
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('recipes', 'meals', 'meal_attendance', 'contacts', 'household_command_receipts', 'notifications', 'notification_reminders', 'notification_preferences', 'notification_subscriptions', 'notification_deliveries')").all<{ name: string }>();
    expect(tables.results.map((row) => row.name).sort()).toEqual([
      "contacts", "household_command_receipts", "meal_attendance", "meals", "notification_deliveries",
      "notification_preferences", "notification_reminders", "notification_subscriptions", "notifications", "recipes",
    ]);
  });

  it("cascades device subscriptions and pending deliveries when their exact session is revoked", async () => {
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES ('storage-session', 'local-owner', 1, '2099-01-01T00:00:00.000Z', ?)").bind(now).run();
    await env.DB.prepare(`INSERT INTO notification_subscriptions
      (id, household_id, member_id, session_hash, endpoint_hash, endpoint, p256dh, auth, created_at, updated_at)
      VALUES ('storage-sub', 'home', 'local-owner', 'storage-session', 'storage-endpoint-hash', 'https://fcm.googleapis.com/fcm/send/storage-fixture', 'fixture-public-key', 'fixture-auth', ?, ?)`)
      .bind(now, now).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO meals (id, household_id, title, cooking_at, timezone, reminder_at, recipes_json, created_at, updated_at)
        VALUES ('storage-meal', 'home', 'Dinner', '2026-11-13T14:00:00.000Z', 'Asia/Kolkata', '2026-11-13T13:00:00.000Z', '[{"name":"Rice"}]', ?, ?)`)
        .bind(now, now),
      env.DB.prepare(`INSERT INTO notifications (id, household_id, member_id, title, body, meal_id, announcement_version, url, created_at)
        VALUES ('storage-notice', 'home', 'local-owner', 'Dinner', 'Are you eating?', 'storage-meal', 1, '/?view=menu&meal=storage-meal', ?)`)
        .bind(now),
      env.DB.prepare(`INSERT INTO notification_deliveries (id, notification_id, subscription_id, next_attempt_at, created_at, updated_at)
        VALUES ('storage-delivery', 'storage-notice', 'storage-sub', ?, ?, ?)`)
        .bind(now, now, now),
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_subscriptions WHERE id = 'storage-sub'").first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE id = 'storage-delivery'").first()).toEqual({ count: 1 });
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = 'storage-session'").run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_subscriptions WHERE id = 'storage-sub'").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE id = 'storage-delivery'").first()).toEqual({ count: 0 });
  });

  it("rejects a subscription member that differs from the continuing session", async () => {
    await env.DB.prepare("INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES ('storage-member', 'home', 'Another member', 'member', ?, ?)").bind(now, now).run();
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES ('storage-owned-session', 'local-owner', 1, '2099-01-01T00:00:00.000Z', ?)").bind(now).run();
    await expect(env.DB.prepare(`INSERT INTO notification_subscriptions
      (id, household_id, member_id, session_hash, endpoint_hash, endpoint, p256dh, auth, created_at, updated_at)
      VALUES ('wrong-member-sub', 'home', 'storage-member', 'storage-owned-session', 'another-hash', 'https://fcm.googleapis.com/fcm/send/another-fixture', 'fixture-public-key', 'fixture-auth', ?, ?)`)
      .bind(now, now).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("retains one bound command receipt per household operation identity", async () => {
    await env.DB.prepare(`INSERT INTO household_command_receipts
      (household_id, operation_id, actor_id, entity_type, entity_id, action, request_hash, result_json, created_at)
      VALUES ('home', 'storage-operation', 'local-owner', 'recipe', 'recipe-one', 'recipe.created', 'request-hash', '{}', ?)`)
      .bind(now).run();
    await expect(env.DB.prepare(`INSERT INTO household_command_receipts
      (household_id, operation_id, actor_id, entity_type, entity_id, action, request_hash, result_json, created_at)
      VALUES ('home', 'storage-operation', 'storage-member', 'contact', 'contact-two', 'contact.created', 'different-hash', '{}', ?)`)
      .bind(now).run()).rejects.toThrow(/UNIQUE/);
  });
});
