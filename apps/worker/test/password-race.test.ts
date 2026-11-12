import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

const origin = "https://home-os.test";
const password = "password concurrency test original";
function request(path: string, body?: unknown, cookie = "") {
  return new Request(`${origin}/api/v1${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: origin, "X-HomeOS-Member": "local-owner", Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function cookieOf(response: Response) {
  return response.headers.getSetCookie().findLast((value) => /^homeos_session=[a-f0-9]{64};/.test(value))!.split(";")[0]!;
}

it("does not revoke the winning password change's session or audit a rejected stale change", async () => {
  const setup = await exports.default.fetch(request("/auth/setup", { name: "Owner", email: "race-owner@example.com", password, setupToken: "test-setup-secret", remember: true }));
  expect(setup.status).toBe(201);
  const cookie = cookieOf(setup);
  let readComplete!: () => void;
  let resumeRead!: () => void;
  const read = new Promise<void>((resolve) => { readComplete = resolve; });
  const resume = new Promise<void>((resolve) => { resumeRead = resolve; });
  const pausedStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => pausedStatement(target.bind(...values));
      if (property === "first") return async () => { const row = await target.first(); readComplete(); await resume; return row; };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (query: string) => {
        const statement = target.prepare(query);
        return query.startsWith("SELECT password_hash, credential_version FROM auth_accounts") ? pausedStatement(statement) : statement;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const stale = worker.fetch(request("/auth/password", { currentPassword: password, newPassword: "stale password change value" }, cookie), { ...env, DB: database });
  await read;
  const winner = await exports.default.fetch(request("/auth/password", { currentPassword: password, newPassword: "winning password change value" }, cookie));
  expect(winner.status).toBe(200);
  const winnerCookie = cookieOf(winner);
  resumeRead();
  expect((await stale).status).toBe(401);
  expect((await exports.default.fetch(request("/items", undefined, winnerCookie))).status).toBe(200);
  const audit = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'member.password_changed'").first<{ count: number }>();
  expect(audit?.count).toBe(1);
});
