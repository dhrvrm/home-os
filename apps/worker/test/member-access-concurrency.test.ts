import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://home-os.test";
const password = "member concurrency test password";

function request(path: string, cookie: string, body?: unknown, method = body ? "POST" : "GET") {
  return new Request(`${origin}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, "X-HomeOS-Member": "local-owner", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function api(path: string, cookie: string, body?: unknown, method?: string) {
  return exports.default.fetch(request(path, cookie, body, method));
}

async function ownerCookie() {
  const response = await api("/auth/setup", "", { name: "Owner", email: "owner@example.com", password, setupToken: "test-setup-secret", remember: true });
  expect(response.status).toBe(201);
  return response.headers.getSetCookie().findLast((value) => /^homeos_session=[a-f0-9]{64};/.test(value))!.split(";")[0]!;
}

async function legacyMember(id: string, email: string | null = null) {
  await env.DB.prepare("INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES (?, 'home', ?, ?, 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
    .bind(id, `Legacy ${id}`, email).run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"), env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_bootstrap"), env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("UPDATE members SET role = 'owner', archived_at = NULL, email = NULL, display_name = 'Home owner' WHERE id = 'local-owner'"),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
});

describe("member access updates", () => {
  it("does not restore access when a name edit resumes after a concurrent deactivation", async () => {
    const cookie = await ownerCookie();
    await legacyMember("race", "race@example.com");
    let readComplete!: () => void;
    let resumeRead!: () => void;
    const read = new Promise<void>((resolve) => { readComplete = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRead = resolve; });
    let intercepted = false;
    const pausedStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => pausedStatement(target.bind(...values));
        if (property === "first") return async (column?: string) => {
          const row = column === undefined ? await target.first() : await target.first(column);
          intercepted = true;
          readComplete();
          await resume;
          return row;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (query: string) => {
          const statement = target.prepare(query);
          return !intercepted && query.includes("FROM members m WHERE m.id = ?") ? pausedStatement(statement) : statement;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const renamed = worker.fetch(request("/members/race", cookie, { name: "Renamed member" }, "PATCH"), { ...env, DB: database });
    await read;
    expect((await api("/members/race", cookie, { active: false, role: "viewer" }, "PATCH")).status).toBe(200);
    resumeRead();
    const response = await renamed;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { member: { name: "Renamed member", active: false, role: "viewer" } } });
    const member = await env.DB.prepare("SELECT display_name, archived_at, role FROM members WHERE id = 'race'").first<{ display_name: string; archived_at: string | null; role: string }>();
    expect(member).toMatchObject({ display_name: "Renamed member", role: "viewer" });
    expect(member?.archived_at).not.toBeNull();
  });

  it("refuses an existing account email while editing a member without credentials", async () => {
    const cookie = await ownerCookie();
    await legacyMember("legacy");
    const response = await api("/members/legacy", cookie, { email: "OWNER@example.com" }, "PATCH");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "email_in_use" } });
    expect(await env.DB.prepare("SELECT email FROM members WHERE id = 'legacy'").first()).toEqual({ email: null });
  });

  it("maps legacy duplicate-email password setup to a conflict and preserves the existing account", async () => {
    const cookie = await ownerCookie();
    await legacyMember("duplicate", "owner@example.com");
    const response = await api("/members/duplicate/password", cookie, { password });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "email_in_use" } });
    expect(await env.DB.prepare("SELECT member_id FROM auth_accounts WHERE email = 'owner@example.com'").first()).toEqual({ member_id: "local-owner" });
    expect(await env.DB.prepare("SELECT member_id FROM auth_accounts WHERE member_id = 'duplicate'").first()).toBeNull();
    expect((await api("/items", cookie)).status).toBe(200);
  });

  it("lets an owner enable a legacy member with a unique email and password", async () => {
    const cookie = await ownerCookie();
    await legacyMember("enabled");
    expect((await api("/members/enabled", cookie, { email: "enabled@example.com" }, "PATCH")).status).toBe(200);
    expect((await api("/members/enabled/password", cookie, { password })).status).toBe(200);
    const login = await api("/auth/login", "", { email: "enabled@example.com", password, remember: false });
    expect(login.status).toBe(200);
    await expect(login.json()).resolves.toMatchObject({ data: { user: { id: "enabled", role: "member" } } });
  });

  it("uses the current member email if another edit completes while password setup is in flight", async () => {
    const cookie = await ownerCookie();
    await legacyMember("email-race", "before@example.com");
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const changed = await api("/members/email-race", cookie, { email: "after@example.com" }, "PATCH");
          expect(changed.status).toBe(200);
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(request("/members/email-race/password", cookie, { password }), { ...env, DB: database });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT email FROM auth_accounts WHERE member_id = 'email-race'").first()).toEqual({ email: "after@example.com" });
    expect((await api("/auth/login", "", { email: "after@example.com", password, remember: false })).status).toBe(200);
    expect((await api("/auth/login", "", { email: "before@example.com", password, remember: false })).status).toBe(401);
  });
});
