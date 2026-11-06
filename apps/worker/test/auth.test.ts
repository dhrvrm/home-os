import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { digest, verifyPassword } from "../src/auth/crypto";
import worker from "../src/index";

const origin = "https://home-os.test";
const password = "correct horse battery staple";
const replacement = "a new household password";

type MemberRole = "owner" | "member" | "viewer";
interface SessionBody { user: { id: string; householdId: string; email: string; role: MemberRole }; expiresAt: string }
interface MemberBody { id: string; name: string; email: string; role: MemberRole; active: boolean; hasLogin: boolean }

async function api(path: string, body?: unknown, cookie?: string, method = body ? "POST" : "GET", headers: HeadersInit = {}) {
  const token = cookie?.split("=")[1];
  const principal = token ? await env.DB.prepare("SELECT member_id FROM auth_sessions WHERE token_hash = ?").bind(await digest(token)).first<{ member_id: string }>() : null;
  return exports.default.fetch(new Request(`${origin}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(principal ? { "X-HomeOS-Member": principal.member_id } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

function cookieOf(response: Response): string {
  const cookie = response.headers.getSetCookie().findLast((value) => /^homeos_session=[a-f0-9]{64};/.test(value));
  if (!cookie) throw new Error("Expected an authenticated session cookie.");
  return cookie.split(";")[0]!;
}

async function setup(remember = true) {
  const response = await api("/auth/setup", {
    name: "Home owner", email: " Owner@Example.com ", password,
    setupToken: "test-setup-secret", remember,
  });
  expect(response.status).toBe(201);
  return response;
}

async function login(email = "owner@example.com", memberPassword = password, remember = false) {
  const response = await api("/auth/login", { email, password: memberPassword, remember });
  expect(response.status).toBe(200);
  return response;
}

async function addMember(ownerCookie: string, role: MemberRole = "member", email = `${role}@example.com`) {
  const response = await api("/members", { name: `Household ${role}`, email, password, role }, ownerCookie);
  expect(response.status).toBe(201);
  const body = await response.json<{ data: { member: MemberBody } }>();
  return body.data.member;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_bootstrap"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("UPDATE members SET role = 'owner', archived_at = NULL, email = NULL, display_name = 'Home owner' WHERE id = 'local-owner'"),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
});

describe("household email/password access", () => {
  it("refuses legacy writes without the expected member so old tabs cannot borrow a new cookie", async () => {
    const cookie = cookieOf(await setup());
    const response = await exports.default.fetch(new Request(`${origin}/api/v1/items`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify({ name: "Old tab item" }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_changed" } });
  });
  it("bounds streamed public login bodies without trusting Content-Length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ email: "owner@example.com", password, padding: "x".repeat(70_000) }));
    const request = new Request(`${origin}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 32_000)); controller.enqueue(bytes.subarray(32_000)); controller.close(); } }),
    });
    expect(request.headers.get("Content-Length")).toBeNull();
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request", field: "body", message: "must be 64 KB or smaller" } });
  });
  it("rejects an old tab's mutations when its expected member differs from the current cookie", async () => {
    const cookie = cookieOf(await setup());
    const response = await api("/sync", { cursor: 0, operations: [] }, cookie, "POST", { "X-HomeOS-Member": "previous-member" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "session_changed" } });
    expect((await api("/items", undefined, cookie, "GET", { "X-HomeOS-Member": "local-owner" })).status).toBe(200);
  });
  it("requires authentication for household data while health and MCP keep their own boundaries", async () => {
    for (const path of ["/items", "/members", "/expenses", "/activity", "/export"]) {
      const response = await api(path);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await api("/sync", { cursor: 0, operations: [] })).status).toBe(401);
    expect((await exports.default.fetch(new Request(`${origin}/healthz`))).status).toBe(200);
    expect((await exports.default.fetch(new Request(`${origin}/mcp`))).status).toBe(401);
  });

  it("does not permit public registration or setup without the deployment secret", async () => {
    await expect((await api("/auth/status")).json()).resolves.toMatchObject({ data: { setupRequired: true, setupAvailable: true, session: null } });
    const denied = await api("/auth/setup", { name: "Attacker", email: "bad@example.com", password, setupToken: "wrong-secret", remember: true });
    expect(denied.status).toBe(403);
    expect((await api("/auth/register", { email: "bad@example.com", password })).status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_accounts").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("fails closed when deployment authentication secrets are absent", async () => {
    const unconfigured = { ...env, HOMEOS_PASSWORD_PEPPER: undefined, HOMEOS_SETUP_TOKEN: undefined };
    const status = await worker.fetch(new Request(`${origin}/api/v1/auth/status`), unconfigured);
    await expect(status.json()).resolves.toMatchObject({ data: { setupRequired: true, setupAvailable: false, session: null } });
    const attemptedLogin = await worker.fetch(new Request(`${origin}/api/v1/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email: "owner@example.com", password }),
    }), unconfigured);
    expect(attemptedLogin.status).toBe(503);
    await expect(attemptedLogin.json()).resolves.toMatchObject({ error: { code: "auth_unavailable" } });
  });

  it("admits only one owner when initial setup requests race", async () => {
    const responses = await Promise.all(["first@example.com", "second@example.com"].map((email) => api("/auth/setup", {
      name: "Home owner", email, password, setupToken: "test-setup-secret", remember: true,
    })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const accounts = await env.DB.prepare("SELECT member_id FROM auth_accounts").all<{ member_id: string }>();
    expect(accounts.results).toEqual([{ member_id: "local-owner" }]);
    const owner = await env.DB.prepare("SELECT email FROM members WHERE id = 'local-owner'").first<{ email: string }>();
    const winningResponse = responses.find((response) => response.status === 201)!;
    const session = await winningResponse.json<{ data: SessionBody }>();
    expect(owner?.email).toBe(session.data.user.email);
  });

  it("bootstraps one owner, persists a cookie session, and revokes it on logout", async () => {
    const response = await setup();
    const cookie = cookieOf(response);
    const header = response.headers.get("Set-Cookie")!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=2592000");
    const session = await response.json<{ data: SessionBody }>();
    const remaining = Date.parse(session.data.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(29 * 86400000);
    expect(remaining).toBeLessThanOrEqual(30 * 86400000);
    const status = await api("/auth/status", undefined, cookie);
    await expect(status.json()).resolves.toMatchObject({ data: { setupRequired: false, session: { user: { id: "local-owner", role: "owner", email: "owner@example.com" } } } });
    expect((await api("/items", undefined, cookie)).status).toBe(200);
    expect((await exports.default.fetch(new Request(`${origin}/mcp`, { headers: { Cookie: cookie } }))).status).toBe(401);
    expect((await api("/auth/setup", { name: "Other", email: "other@example.com", password, setupToken: "test-setup-secret" })).status).toBe(409);
    const ended = await api("/auth/logout", {}, cookie);
    expect(ended.status).toBe(200);
    expect(ended.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await api("/items", undefined, cookie)).status).toBe(401);
    const { results } = await env.DB.prepare("SELECT token_hash FROM auth_sessions").all();
    expect(results).toHaveLength(0);
  });

  it("keeps only a salted peppered password verifier and hashed opaque session tokens", async () => {
    const response = await setup();
    const rawToken = cookieOf(response).split("=")[1]!;
    const account = await env.DB.prepare("SELECT password_hash FROM auth_accounts WHERE member_id = 'local-owner'").first<{ password_hash: string }>();
    expect(account!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$[a-f0-9]{64}\$[a-f0-9]{64}$/);
    expect(account!.password_hash).not.toContain(password);
    expect(await verifyPassword(password, account!.password_hash, "test-pepper-at-least-thirty-two-characters-long")).toBe(true);
    expect(await verifyPassword(password, account!.password_hash, "different independent credential secret")).toBe(false);
    const session = await env.DB.prepare("SELECT token_hash FROM auth_sessions").first<{ token_hash: string }>();
    expect(session!.token_hash).toBe(await digest(rawToken));
    expect(session!.token_hash).not.toBe(rawToken);
    const audit = await env.DB.prepare("SELECT * FROM audit_events").all();
    expect(JSON.stringify(audit.results)).not.toContain(password);
    expect(JSON.stringify(audit.results)).not.toContain(rawToken);
    expect(JSON.stringify(audit.results)).not.toContain(account!.password_hash);
  });

  it("normalizes emails and supports a shorter browser-session cookie without remembering", async () => {
    await setup();
    const response = await login(" OWNER@EXAMPLE.COM ");
    const cookie = cookieOf(response);
    const liveCookie = response.headers.getSetCookie().findLast((value) => value.startsWith(cookie))!;
    expect(liveCookie).not.toContain("Max-Age");
    const session = await response.json<{ data: SessionBody }>();
    expect(session.data.user.email).toBe("owner@example.com");
    const remaining = Date.parse(session.data.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(11 * 3600000);
    expect(remaining).toBeLessThanOrEqual(12 * 3600000);
    expect((await api("/items", undefined, cookie)).status).toBe(200);
  });

  it("rotates the presented session during sign-in", async () => {
    const oldCookie = cookieOf(await setup());
    const response = await api("/auth/login", { email: "owner@example.com", password, remember: true }, oldCookie);
    expect(response.status).toBe(200);
    const newCookie = cookieOf(response);
    expect(newCookie).not.toBe(oldCookie);
    expect((await api("/items", undefined, oldCookie)).status).toBe(401);
    expect((await api("/items", undefined, newCookie)).status).toBe(200);
  });

  it("uses the same credential error for unknown accounts and wrong passwords", async () => {
    await setup();
    const unknown = await api("/auth/login", { email: "absent@example.com", password });
    const wrong = await api("/auth/login", { email: "owner@example.com", password: "wrong account password" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(unknown.headers.getSetCookie()).toHaveLength(0);
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
  });

  it("rejects expired, forged, and credential-version-revoked cookies", async () => {
    const cookie = cookieOf(await setup());
    expect((await api("/items", undefined, "homeos_session=bad-token")).status).toBe(401);
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await api("/items", undefined, cookie)).status).toBe(401);
    await expect((await api("/auth/status", undefined, cookie)).json()).resolves.toMatchObject({ data: { session: null } });
    const freshCookie = cookieOf(await login());
    await env.DB.prepare("UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'local-owner'").run();
    expect((await api("/items", undefined, freshCookie)).status).toBe(401);
  });

  it("blocks cross-origin mutations and form submissions before any household change", async () => {
    const cookie = cookieOf(await setup());
    expect((await api("/items", { name: "Injected item" }, cookie, "POST", { Origin: "https://attacker.test" })).status).toBe(403);
    expect((await api("/auth/logout", {}, cookie, "POST", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await api("/items", { name: "Injected item" }, cookie, "POST", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await api("/items", undefined, cookie)).status).toBe(200);
  });

  it("validates new credentials and rolls duplicate member creation back completely", async () => {
    const cookie = cookieOf(await setup());
    expect((await api("/members", { name: "Short", email: "short@example.com", password: "short" }, cookie)).status).toBe(400);
    expect((await api("/members", { name: "Long", email: "long@example.com", password: "x".repeat(129) }, cookie)).status).toBe(400);
    expect((await api("/members", { name: "Bad email", email: "not-an-email", password }, cookie)).status).toBe(400);
    await addMember(cookie);
    const duplicate = await api("/members", { name: "Duplicate", email: " MEMBER@EXAMPLE.COM ", password }, cookie);
    expect(duplicate.status).toBe(409);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM members").first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  it("lets owners manage accounts while members cannot create, reset, or deactivate people", async () => {
    const ownerCookie = cookieOf(await setup());
    const member = await addMember(ownerCookie);
    const memberCookie = cookieOf(await login(member.email));
    expect((await api("/members", undefined, memberCookie)).status).toBe(200);
    expect((await api("/members", { name: "Escalation", email: "escalation@example.com", password, role: "owner" }, memberCookie)).status).toBe(403);
    expect((await api(`/members/${member.id}`, { role: "owner" }, memberCookie, "PATCH")).status).toBe(403);
    expect((await api("/members/local-owner", { active: false }, memberCookie, "PATCH")).status).toBe(403);
    expect((await api("/members/local-owner/password", { password: replacement }, memberCookie)).status).toBe(403);
    const updated = await api(`/members/${member.id}`, { name: "Housemate", email: "housemate@example.com" }, ownerCookie, "PATCH");
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ data: { member: { id: member.id, name: "Housemate", email: "housemate@example.com" } } });
    expect((await api("/auth/login", { email: member.email, password })).status).toBe(401);
    expect((await login("housemate@example.com")).status).toBe(200);
  });

  it("keeps at least one active owner and preserves the owner session after refused changes", async () => {
    const cookie = cookieOf(await setup());
    expect((await api("/members/local-owner", { active: false }, cookie, "PATCH")).status).toBe(409);
    expect((await api("/members/local-owner", { role: "member" }, cookie, "PATCH")).status).toBe(409);
    expect((await api("/members/local-owner/password", { password: replacement }, cookie)).status).toBe(400);
    expect((await api("/items", undefined, cookie)).status).toBe(200);
    const coOwner = await addMember(cookie, "owner", "co-owner@example.com");
    const coOwnerCookie = cookieOf(await login(coOwner.email));
    expect((await api("/members/local-owner", { role: "member" }, coOwnerCookie, "PATCH")).status).toBe(200);
    expect((await api("/members", { name: "Denied", email: "denied@example.com", password }, cookie)).status).toBe(403);
    expect((await api(`/members/${coOwner.id}`, { active: false }, coOwnerCookie, "PATCH")).status).toBe(409);
  });

  it("enforces viewer permissions on direct and queued writes while allowing their own password change", async () => {
    const ownerCookie = cookieOf(await setup());
    const viewer = await addMember(ownerCookie, "viewer");
    const cookie = cookieOf(await login(viewer.email));
    expect((await api("/items", undefined, cookie)).status).toBe(200);
    expect((await api("/items", { name: "Forbidden" }, cookie)).status).toBe(403);
    expect((await api("/sync", { cursor: 0, operations: [] }, cookie)).status).toBe(403);
    const changed = await api("/auth/password", { currentPassword: password, newPassword: replacement }, cookie);
    expect(changed.status).toBe(200);
    expect((await api("/items", undefined, cookieOf(changed))).status).toBe(200);
  });

  it("attributes both direct writes and delayed sync operations to the authenticated member", async () => {
    const ownerCookie = cookieOf(await setup());
    const member = await addMember(ownerCookie);
    const cookie = cookieOf(await login(member.email));
    const directOperation = crypto.randomUUID();
    const direct = await api("/items", { name: "Member soap" }, cookie, "POST", { "X-Operation-ID": directOperation, "X-Actor-ID": "local-owner" });
    expect(direct.status).toBe(201);
    const queuedOperation = crypto.randomUUID();
    const sync = await api("/sync", { cursor: 0, operations: [{
      operationId: queuedOperation, householdId: "home", deviceId: "member-device", actorId: "local-owner",
      kind: "inventory.create", entityId: crypto.randomUUID(), expectedVersion: 0,
      clientTime: new Date().toISOString(), payload: { name: "Member rice" },
    }] }, cookie);
    expect(sync.status).toBe(200);
    await expect(sync.json()).resolves.toMatchObject({ data: { results: [{ operationId: queuedOperation, status: "accepted" }] } });
    const audit = await env.DB.prepare("SELECT actor_id, operation_id FROM audit_events WHERE operation_id IN (?, ?) ORDER BY operation_id")
      .bind(directOperation, queuedOperation).all<{ actor_id: string; operation_id: string }>();
    expect(audit.results).toHaveLength(2);
    expect(audit.results.every((event) => event.actor_id === member.id)).toBe(true);
  });

  it("changes a password only with current proof and revokes all old sessions and passwords", async () => {
    const cookie = cookieOf(await setup());
    const otherSession = cookieOf(await login());
    expect((await api("/auth/password", { currentPassword: "incorrect old password", newPassword: replacement }, cookie)).status).toBe(400);
    expect((await api("/items", undefined, cookie)).status).toBe(200);
    const changed = await api("/auth/password", { currentPassword: password, newPassword: replacement }, cookie);
    expect(changed.status).toBe(200);
    expect((await api("/items", undefined, cookie)).status).toBe(401);
    expect((await api("/items", undefined, otherSession)).status).toBe(401);
    expect((await api("/items", undefined, cookieOf(changed))).status).toBe(200);
    expect((await api("/auth/login", { email: "owner@example.com", password })).status).toBe(401);
    expect((await login("owner@example.com", replacement)).status).toBe(200);
  });

  it("revokes active member sessions on password reset and departure without deleting their identity", async () => {
    const ownerCookie = cookieOf(await setup());
    const member = await addMember(ownerCookie);
    const cookie = cookieOf(await login(member.email));
    expect((await api(`/members/${member.id}/password`, { password: replacement }, ownerCookie)).status).toBe(200);
    expect((await api("/items", undefined, cookie)).status).toBe(401);
    expect((await api("/auth/login", { email: member.email, password })).status).toBe(401);
    const freshCookie = cookieOf(await login(member.email, replacement));
    expect((await api(`/members/${member.id}`, { active: false }, ownerCookie, "PATCH")).status).toBe(200);
    expect((await api("/items", undefined, freshCookie)).status).toBe(401);
    expect((await api("/auth/login", { email: member.email, password: replacement })).status).toBe(401);
    const record = await env.DB.prepare("SELECT id, archived_at FROM members WHERE id = ?").bind(member.id).first<{ id: string; archived_at: string | null }>();
    expect(record?.id).toBe(member.id);
    expect(record?.archived_at).toBeTruthy();
    expect((await api(`/members/${member.id}`, { active: true }, ownerCookie, "PATCH")).status).toBe(200);
    expect((await api("/items", undefined, freshCookie)).status).toBe(401);
    expect((await login(member.email, replacement)).status).toBe(200);
  });

  it("limits repeated password guesses and provides a bounded retry delay", async () => {
    await setup();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await api("/auth/login", { email: "owner@example.com", password: "incorrect password" })).status).toBe(401);
    }
    const blocked = await api("/auth/login", { email: "owner@example.com", password });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("Retry-After"))).toBeLessThanOrEqual(900);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
    const attempts = await env.DB.prepare("SELECT attempt_key FROM auth_attempts").all<{ attempt_key: string }>();
    expect(attempts.results.every((entry) => /^[a-f0-9]{64}$/.test(entry.attempt_key))).toBe(true);
  });
});
