import { env, exports } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { app } from "../src/index";
import { digest } from "../src/auth/crypto";
import { hasNotificationDeliveryAuthority } from "../src/auth/session";
import { SessionAccessService } from "../src/auth/session-access";
import { notificationAuthority, resetNotifications, seedNotificationMember, seedNotificationMeal, pushFixture } from "./notification-fixtures";
import { NotificationRepository } from "../src/notifications/d1-repository";

const origin = "https://home-os.test";
const now = new Date().toISOString();
beforeEach(resetNotifications);

it("runs the actual migration backfill only for currently valid credentials, preserving both FK children", async () => {
  await seedNotificationMember();
  await seedNotificationMember("notice-inactive", "member", "b".repeat(64));
  await env.DB.prepare("UPDATE auth_sessions SET permanent = 0").run();
  await env.DB.prepare("UPDATE members SET archived_at = ? WHERE id = 'notice-inactive'").bind(now).run();
  await seedNotificationMeal(now);
  for (const [id, expiry, version] of [["valid", "2099-01-01T00:00:00.000Z", 1], ["expired", "2000-01-01T00:00:00.000Z", 1], ["stale", "2099-01-01T00:00:00.000Z", 0]] as const) {
    await env.DB.prepare("INSERT INTO auth_sessions(token_hash, member_id, credential_version, expires_at, created_at, public_id) VALUES (?, 'local-owner', ?, ?, ?, lower(hex(randomblob(16))))").bind(id, version, expiry, now).run();
    await env.DB.prepare(`INSERT INTO notification_subscriptions (id, household_id, member_id, session_hash, endpoint_hash, endpoint, p256dh, auth, created_at, updated_at)
      VALUES (?, 'home', 'local-owner', ?, ?, 'https://fcm.googleapis.com/fcm/send/migration', 'public', 'secret', ?, ?)`)
      .bind(`sub-${id}`, id, id, now, now).run();
    await env.DB.prepare(`INSERT INTO notifications (id, household_id, member_id, title, body, meal_id, announcement_version, url, created_at)
      VALUES (?, 'home', 'local-owner', 'Dinner', 'Dinner', 'notice-meal', 1, '/', ?)`).bind(`notice-${id}`, now).run();
    await env.DB.prepare("INSERT INTO notification_deliveries (id, notification_id, subscription_id, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`delivery-${id}`, `notice-${id}`, `sub-${id}`, now, now, now).run();
  }
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('boundary','local-owner',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)").bind(now).run();
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('revoked','local-owner',1,'2099-01-01T00:00:00.000Z',?)").bind(now).run();
  await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = 'revoked'").run();
  expect(await env.DB.prepare("SELECT SUM(permanent) n FROM auth_sessions").first("n")).toBe(0);
  const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
  const migration = migrations.find(m => m.name.includes("0008"))!;
  // The additive schema has already been applied by test setup. Replay its exact
  // data migration against populated legacy rows, rather than mocking permanence.
  const backfill = migration.queries.find(query => query.includes("UPDATE auth_sessions SET permanent = 1"))!;
  expect(backfill).toBeTruthy();
  for (const query of migration.queries.filter(query => query.includes("UPDATE auth_sessions SET permanent = 1") || (query.includes("DELETE FROM auth_sessions") && !query.includes("CREATE TRIGGER")))) {
    await env.DB.prepare(query).run();
  }
  const rows = await env.DB.prepare("SELECT token_hash, permanent, public_id FROM auth_sessions").all<{ token_hash: string; permanent: number; public_id: string }>();
  const policies = Object.fromEntries(rows.results.map(row => [row.token_hash, row.permanent]));
  expect(policies.valid).toBe(1);
  expect(policies.expired).toBe(0);
  expect(policies.stale).toBeUndefined();
  expect(policies.boundary).toBe(0);
  expect(policies.revoked).toBeUndefined();
  expect(policies[await digest("b".repeat(64))]).toBeUndefined();
  await env.DB.prepare("UPDATE members SET archived_at = NULL WHERE id = 'notice-inactive'").run();
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "notice-inactive", await digest("b".repeat(64)), now)).toBe(false);
  expect(rows.results.every(row => /^[a-f0-9]{32}$/.test(row.public_id))).toBe(true);
  expect(await env.DB.prepare("SELECT id FROM notification_subscriptions ORDER BY id").all()).toMatchObject({ results: [{ id: "sub-expired" }, { id: "sub-valid" }] });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM notification_deliveries").first("n")).toBe(2);
  expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", "valid", "2100-01-01T00:00:00.000Z")).toBe(true);
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", "expired", now)).toBe(false);
  await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = 'valid'").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM notification_deliveries").first("n")).toBe(1);
});

it("renews permanent HTTPS cookies only on explicit status checks without writing D1 and survives creation-time metadata", async () => {
  const hash = await seedNotificationMember();
  await env.DB.prepare("UPDATE auth_sessions SET permanent = 1, expires_at = '2000-01-01T00:00:00.000Z'").run();
  let writes = 0;
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes++; return target.prepare(sql); };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await app.fetch(new Request(`${origin}/api/v1/items`, { headers: { Cookie: `homeos_session=${"a".repeat(64)}` } }), { ...env, DB: database });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toEqual([]);
  const status = await app.fetch(new Request(`${origin}/api/v1/auth/status`, { headers: { Cookie: `homeos_session=${"a".repeat(64)}`, "X-HomeOS-Session-Renew": "1" } }), { ...env, DB: database });
  expect(status.status).toBe(200);
  expect(status.headers.get("Set-Cookie")).toMatch(/Max-Age=34560000; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  expect(writes).toBe(0);
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", hash, "2100-01-01T00:00:00.000Z")).toBe(true);
});

it("lists bounded public grants and revokes the exact device with its delivery children", async () => {
  const hash = await seedNotificationMember();
  const other = await digest("c".repeat(64));
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash, member_id, credential_version, expires_at, created_at, permanent) VALUES (?, 'local-owner', 1, ?, ?, 1)").bind(other, now, now).run();
  const context = await notificationAuthority();
  const service = new SessionAccessService(env.DB);
  const first = await service.listSessions(context, { limit: 1 });
  expect(first.sessions).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
  expect((await service.listSessions(context, { limit: 1, cursor: first.nextCursor! })).sessions).toHaveLength(1);
  const all = await service.listSessions(context);
  const current = all.sessions.find(row => row.current)!;
  const fixture = await pushFixture();
  const repo = new NotificationRepository(env.DB, "home");
  await repo.registerSubscription("local-owner", { tokenHash: hash, expiresAt: null, credentialVersion: 1 }, fixture.subscription, await digest(fixture.subscription.endpoint), now);
  const response = await exports.default.fetch(new Request(`${origin}/api/v1/auth/sessions/${current.id}/revoke`, { method: "POST", headers: { Cookie: `homeos_session=${"a".repeat(64)}`, Origin: origin, "Content-Type": "application/json", "X-HomeOS-Member": "local-owner" }, body: "{}" }));
  expect(response.status).toBe(200); expect(response.headers.getSetCookie()).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM notification_subscriptions").first("n")).toBe(0);
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", other, now)).toBe(true);
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", hash, now)).toBe(false);
});

it("allows only owners to inspect/revoke other subjects and refuses revoked authority at acceptance", async () => {
  await seedNotificationMember();
  await seedNotificationMember("notice-reader", "viewer", "b".repeat(64));
  const owner = await notificationAuthority();
  const reader = await notificationAuthority("notice-reader");
  const service = new SessionAccessService(env.DB);
  const target = (await service.listSessions(owner)).sessions[0]!;
  await expect(service.listSessions(reader, { memberId: "local-owner" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(service.revokeSession(reader, target.id)).rejects.toMatchObject({ code: "forbidden" });
  expect((await service.listSessions(owner, { memberId: "notice-reader" })).sessions).toHaveLength(1);
  const own = (await service.listSessions(reader)).sessions[0]!;
  await service.revokeSession(owner, own.id);
  await expect(service.revokeSession(reader, target.id)).rejects.toMatchObject({ code: "forbidden" });
  expect((await service.listSessions(owner)).sessions).toHaveLength(1);
});

it("rolls back a session revoke when its exact source disappears between read and batch", async () => {
  const hash = await seedNotificationMember();
  await seedNotificationMember("notice-reader", "viewer", "b".repeat(64));
  const context = await notificationAuthority();
  const service = new SessionAccessService(env.DB);
  const target = (await service.listSessions(context, { memberId: "notice-reader" })).sessions[0]!;
  const database = new Proxy(env.DB, { get(db, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(hash).run();
      return db.batch(statements);
    };
    const value = Reflect.get(db, property, db); return typeof value === "function" ? value.bind(db) : value;
  } });
  await expect(new SessionAccessService(database).revokeSession(context, target.id)).rejects.toMatchObject({ code: "forbidden" });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM auth_sessions WHERE public_id = ?").bind(target.id).first("n")).toBe(1);
});

it("upgrades only a still-valid post-migration legacy grant on first authenticated use", async () => {
  const hash = await seedNotificationMember();
  await env.DB.prepare("UPDATE auth_sessions SET permanent = 0").run();
  expect(await env.DB.prepare("SELECT permanent FROM auth_sessions WHERE token_hash = ?").bind(hash).first("permanent")).toBe(0);
  const response = await exports.default.fetch(new Request(`${origin}/api/v1/auth/status`, { headers: { Cookie: `homeos_session=${"a".repeat(64)}` } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { session: { expiresAt: null } } });
  expect(await env.DB.prepare("SELECT permanent FROM auth_sessions WHERE token_hash = ?").bind(hash).first("permanent")).toBe(1);
  const expired = await digest("c".repeat(64));
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES (?,'local-owner',1,'2000-01-01T00:00:00.000Z',?)").bind(expired, now).run();
  const rejected = await exports.default.fetch(new Request(`${origin}/api/v1/auth/status`, { headers: { Cookie: `homeos_session=${"c".repeat(64)}` } }));
  expect(await rejected.json()).toMatchObject({ data: { session: null } });
  expect(await env.DB.prepare("SELECT permanent FROM auth_sessions WHERE token_hash = ?").bind(expired).first("permanent")).toBe(0);
});

it("preserves new grants under old runtime cleanup and promotes valid old-runtime inserts throughout rollout", async () => {
  const response = await exports.default.fetch(new Request(`${origin}/api/v1/auth/setup`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Owner", email: "rollout@example.test", password: "rollout password long enough", setupToken: "test-setup-secret" }) }));
  expect(response.status).toBe(201);
  const cookie = response.headers.getSetCookie().findLast(value => /^homeos_session=[a-f0-9]{64};/.test(value))!.split(";")[0]!;
  await env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
  expect((await exports.default.fetch(new Request(`${origin}/api/v1/items`, { headers: { Cookie: cookie } }))).status).toBe(200);
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('rolling','local-owner',1,?,?)")
    .bind(new Date(Date.now() + 12 * 3600000).toISOString(), now).run();
  expect(await env.DB.prepare("SELECT permanent FROM auth_sessions WHERE token_hash = 'rolling'").first("permanent")).toBe(1);
  expect(await hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", "rolling", "2100-01-01T00:00:00.000Z")).toBe(true);
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('rolling-stale','local-owner',0,'2099-01-01T00:00:00.000Z',?)").bind(now).run();
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('rolling-boundary','local-owner',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)").bind(now).run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM auth_sessions WHERE token_hash = 'rolling-stale'").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT permanent FROM auth_sessions WHERE token_hash = 'rolling-boundary'").first("permanent")).toBe(0);
  await seedNotificationMember("notice-rolling-inactive", "member", "d".repeat(64));
  await env.DB.prepare("UPDATE members SET archived_at = ? WHERE id = 'notice-rolling-inactive'").bind(now).run();
  await env.DB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES ('rolling-inactive','notice-rolling-inactive',1,'2099-01-01T00:00:00.000Z',?)").bind(now).run();
  await env.DB.prepare("UPDATE members SET archived_at = NULL WHERE id = 'notice-rolling-inactive'").run();
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM auth_sessions WHERE token_hash = 'rolling-inactive'").first("n")).toBe(0);
});
