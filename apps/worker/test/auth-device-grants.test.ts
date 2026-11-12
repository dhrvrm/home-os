import { Hono } from "hono";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { digest } from "../src/auth/crypto";
import { currentDeviceGrant, hasNotificationDeliveryAuthority, protectHousehold } from "../src/auth/session";
import { authenticatedFetch } from "./authenticated-worker";

const origin = "https://home-os.test";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM members WHERE id = 'reader'"),
  ]);
});

async function seedOwner() {
  await authenticatedFetch(new Request(`${origin}/api/v1/members`));
  return digest("a".repeat(64));
}

describe("continuing device authority", () => {
  it("requires the exact live member, household, and credential grant", async () => {
    const hash = await seedOwner();
    const now = new Date().toISOString();
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", hash, now)).resolves.toBe(true);
    await expect(hasNotificationDeliveryAuthority(env.DB, "other-home", "local-owner", hash, now)).resolves.toBe(false);
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "someone-else", hash, now)).resolves.toBe(false);
    await env.DB.prepare("UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'local-owner'").run();
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", hash, now)).resolves.toBe(false);
  });

  it("expires device delivery at the exact session deadline", async () => {
    const hash = await seedOwner();
    const deadline = new Date().toISOString();
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?").bind(deadline, hash).run();
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", hash, deadline)).resolves.toBe(false);
  });

  it("replacing the incoming login cookie revokes that grant while preserving another device", async () => {
    const oldHash = await seedOwner();
    const otherHash = await digest("c".repeat(64));
    await env.DB.prepare("INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, 'local-owner', 1, '2099-01-01T00:00:00.000Z', ?)")
      .bind(otherHash, new Date().toISOString()).run();
    const response = await exports.default.fetch(new Request(`${origin}/api/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: `homeos_session=${"a".repeat(64)}` },
      body: JSON.stringify({ email: "fixture-owner@home-os.test", password: "fixture owner password", remember: true }),
    }));
    expect(response.status).toBe(200);
    const now = new Date().toISOString();
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", oldHash, now)).resolves.toBe(false);
    await expect(hasNotificationDeliveryAuthority(env.DB, "home", "local-owner", otherHash, now)).resolves.toBe(true);
    expect(JSON.stringify(await response.json())).not.toContain("tokenHash");
  });

  it("allows only personal notification writes for viewers and retains request admission checks", async () => {
    await seedOwner();
    const now = new Date().toISOString();
    const token = "b".repeat(64);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES ('reader', 'home', 'Reader', 'reader@example.test', 'viewer', ?, ?)").bind(now, now),
      env.DB.prepare("INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES ('reader', 'reader@example.test', 'unused-fixture-verifier', ?)").bind(now),
      env.DB.prepare("INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, 'reader', 1, '2099-01-01T00:00:00.000Z', ?)").bind(await digest(token), now),
    ]);
    const app = new Hono<{ Bindings: Env }>();
    app.use("/api/v1/*", protectHousehold);
    app.put("/api/v1/notifications/preferences", (context) => context.json({ hasGrant: !!currentDeviceGrant(context).tokenHash }));
    app.patch("/api/v1/contacts/contact", (context) => context.json({ changed: true }));
    const send = (path: string, overrides: HeadersInit = {}, method = "PUT") => app.fetch(new Request(`${origin}/api/v1${path}`, {
      method, headers: { "Content-Type": "application/json", Origin: origin, Cookie: `homeos_session=${token}`, "X-HomeOS-Member": "reader", ...overrides }, body: "{}",
    }), env);
    expect((await send("/notifications/preferences")).status).toBe(200);
    expect((await send("/contacts/contact", {}, "PATCH")).status).toBe(403);
    expect((await send("/notifications/preferences", { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await send("/notifications/preferences", { "X-HomeOS-Member": "someone-else" })).status).toBe(409);
    expect((await send("/notifications/preferences", { "Content-Type": "text/plain" })).status).toBe(415);
  });
});
