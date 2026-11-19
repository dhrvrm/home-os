import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const origin = "https://home-os.test";
const password = "usable owner fixture password";
let cookie = "";

async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  return exports.default.fetch(new Request(`${origin}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, "X-HomeOS-Member": "local-owner", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

async function accountlessOwner() {
  await env.DB.prepare("INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES ('legacy-owner', 'home', 'Legacy owner', 'legacy@fixture.test', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();
}

beforeEach(async () => {
  cookie = "";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_bootstrap"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM household_command_receipts"),
    env.DB.prepare("UPDATE members SET role = 'owner', archived_at = NULL WHERE id = 'local-owner'"),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
  const response = await api("/auth/setup", { name: "Owner", email: "owner@fixture.test", password, setupToken: "test-setup-secret" });
  expect(response.status).toBe(201);
  cookie = response.headers.getSetCookie().findLast(value => /^homeos_session=[a-f0-9]{64};/.test(value))!.split(";")[0]!;
});

describe("an owner who can still sign in", () => {
  it.each([{ role: "member" }, { active: false }])("does not count an accountless owner as a replacement: %j", async patch => {
    await accountlessOwner();
    const response = await api("/members/local-owner", patch, "PATCH");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "last_owner" } });
    expect(await env.DB.prepare("SELECT role, archived_at FROM members WHERE id = 'local-owner'").first()).toEqual({ role: "owner", archived_at: null });
    expect((await api("/items")).status).toBe(200);
  });

  it("allows another active owner with a login to take over", async () => {
    expect((await api("/members", { name: "Replacement", email: "replacement@fixture.test", password, role: "owner" })).status).toBe(201);
    expect((await api("/members/local-owner", { role: "member" }, "PATCH")).status).toBe(200);
    await expect((await api("/auth/status")).json()).resolves.toMatchObject({ data: { session: { user: { role: "member" } } } });
  });

  it("allows removing an accountless owner while preserving the usable owner", async () => {
    await accountlessOwner();
    expect((await api("/members/legacy-owner", { active: false }, "PATCH")).status).toBe(200);
    expect((await api("/members/local-owner", { role: "member" }, "PATCH")).status).toBe(409);
  });

  it("preserves first-owner setup from the accountless bootstrap sentinel", async () => {
    await expect((await api("/auth/status")).json()).resolves.toMatchObject({ data: { setupRequired: false, session: { user: { id: "local-owner", role: "owner" }, expiresAt: null } } });
  });
});
