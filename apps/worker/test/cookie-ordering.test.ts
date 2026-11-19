import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { app } from "../src/index";

const origin = "https://home-os.test";
const password = "cookie ordering original password";
function request(path: string, body?: unknown, cookie = "") {
  return new Request(`${origin}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-HomeOS-Member": "local-owner" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookieOf(response: Response) {
  return response.headers.getSetCookie().findLast(value => /^homeos_session=[a-f0-9]{64};/.test(value))!.split(";")[0]!;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_events"), env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"), env.DB.prepare("DELETE FROM auth_bootstrap"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
});
async function setup() {
  const response = await exports.default.fetch(request("/auth/setup", { name: "Owner", email: "cookie-owner@example.com", password, setupToken: "test-setup-secret" }));
  expect(response.status).toBe(201);
  return cookieOf(response);
}
async function switchAccount(cookie: string) {
  const member = await exports.default.fetch(request("/members", { name: "Other", email: "cookie-other@example.com", password, role: "member" }, cookie));
  expect(member.status).toBe(201);
  const response = await exports.default.fetch(request("/auth/login", { email: "cookie-other@example.com", password }, cookie));
  expect(response.status).toBe(200);
  return cookieOf(response);
}

it.each(["account switch", "password replacement"])("a held old inventory request cannot overwrite the cookie after %s", async (change) => {
  const oldCookie = await setup();
  const admitted = latch(), resume = latch();
  const pause = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => pause(target.bind(...values));
    if (property === "first") return async () => { const row = await target.first(); admitted.resolve(); await resume.promise; return row; };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => sql.includes("SELECT m.id, m.household_id, m.display_name") ? pause(target.prepare(sql)) : target.prepare(sql);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const oldRequest = app.fetch(request("/items", undefined, oldCookie), { ...env, DB: database });
  await admitted.promise;
  const changed = change === "password replacement"
    ? await exports.default.fetch(request("/auth/password", { currentPassword: password, newPassword: "cookie ordering replacement password" }, oldCookie)) : null;
  if (changed) expect(changed.status).toBe(200);
  const newerCookie = changed ? cookieOf(changed) : await switchAccount(oldCookie);
  resume.resolve();
  const late = await oldRequest;
  expect(late.status).toBe(200);
  expect(late.headers.getSetCookie()).toEqual([]);
  expect((await exports.default.fetch(request("/items", undefined, oldCookie))).status).toBe(401);
  expect((await exports.default.fetch(request("/items", undefined, newerCookie))).status).toBe(changed ? 200 : 409); // expected-member still names the old owner
  await expect((await exports.default.fetch(request("/auth/status", undefined, newerCookie))).json()).resolves.toMatchObject({ data: { session: { user: { email: changed ? "cookie-owner@example.com" : "cookie-other@example.com" } } } });
});

it("a held logout deletes only the incoming grant without clearing a later login", async () => {
  const oldCookie = await setup();
  const deleted = latch(), resume = latch();
  const pause = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => pause(target.bind(...values));
    if (property === "run") return async () => { const result = await target.run(); deleted.resolve(); await resume.promise; return result; };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => sql === "DELETE FROM auth_sessions WHERE token_hash = ?" ? pause(target.prepare(sql)) : target.prepare(sql);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const pending = app.fetch(request("/auth/logout", {}, oldCookie), { ...env, DB: database });
  await deleted.promise;
  const login = await exports.default.fetch(request("/auth/login", { email: "cookie-owner@example.com", password }, oldCookie));
  expect(login.status).toBe(200);
  const newerCookie = cookieOf(login);
  resume.resolve();
  const late = await pending;
  expect(late.status).toBe(200); expect(late.headers.getSetCookie()).toEqual([]);
  expect((await exports.default.fetch(request("/items", undefined, oldCookie))).status).toBe(401);
  expect((await exports.default.fetch(request("/items", undefined, newerCookie))).status).toBe(200);
});

it("only explicit valid status renewal writes retention cookies", async () => {
  const cookie = await setup();
  for (const path of ["/auth/status", "/items"]) {
    expect((await exports.default.fetch(request(path, undefined, cookie))).headers.getSetCookie()).toEqual([]);
  }
  const renewed = request("/auth/status", undefined, cookie);
  renewed.headers.set("X-HomeOS-Session-Renew", "1");
  expect((await exports.default.fetch(renewed)).headers.get("Set-Cookie")).toContain("Max-Age=34560000");
  const ordinary = request("/items", undefined, cookie); ordinary.headers.set("X-HomeOS-Session-Renew", "1");
  expect((await exports.default.fetch(ordinary)).headers.getSetCookie()).toEqual([]);
  const legacy = request("/auth/status", undefined, cookie); legacy.headers.set("X-HomeOS-Session-Renew", "true");
  expect((await exports.default.fetch(legacy)).headers.getSetCookie()).toEqual([]);
  await exports.default.fetch(request("/auth/logout", {}, cookie));
  const revoked = request("/auth/status", undefined, cookie); revoked.headers.set("X-HomeOS-Session-Renew", "1");
  const response = await exports.default.fetch(revoked);
  expect(response.headers.getSetCookie()).toEqual([]);
  await expect(response.json()).resolves.toMatchObject({ data: { session: null } });
});

it("a current-session revoke finishing after a newer login cannot clear its cookie", async () => {
  const oldCookie = await setup();
  const sessions = await (await exports.default.fetch(request("/auth/sessions", undefined, oldCookie))).json<{ data: { sessions: { id: string }[] } }>();
  const deleted = latch(), resume = latch();
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { const result = await target.batch(statements); deleted.resolve(); await resume.promise; return result; };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const oldRequest = app.fetch(request(`/auth/sessions/${sessions.data.sessions[0]!.id}/revoke`, {}, oldCookie), { ...env, DB: database });
  await deleted.promise;
  const login = await exports.default.fetch(request("/auth/login", { email: "cookie-owner@example.com", password }, oldCookie));
  expect(login.status).toBe(200);
  const newerCookie = cookieOf(login);
  resume.resolve();
  const late = await oldRequest;
  expect(late.status).toBe(200);
  await expect(late.json()).resolves.toMatchObject({ data: { revoked: true, current: true } });
  expect(late.headers.getSetCookie()).toEqual([]);
  expect((await exports.default.fetch(request("/items", undefined, oldCookie))).status).toBe(401);
  expect((await exports.default.fetch(request("/items", undefined, newerCookie))).status).toBe(200);
});
