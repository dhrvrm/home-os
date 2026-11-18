import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("personal OAuth protocol", () => {
  it("advertises canonical resource and only supported revocation controls", async () => {
    const resource = await exports.default.fetch(new Request("https://home-os.test/.well-known/oauth-protected-resource/mcp"));
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: "https://home-os.test/mcp", authorization_servers: ["https://home-os.test"] });
    const discovery = await exports.default.fetch(new Request("https://home-os.test/.well-known/oauth-authorization-server"));
    const metadata = await discovery.json();
    expect(metadata).toMatchObject({ issuer: "https://home-os.test", authorization_endpoint: "https://home-os.test/api/oauth/authorize", token_endpoint: "https://home-os.test/api/oauth/token", code_challenge_methods_supported: ["S256"] });
    expect(metadata).not.toHaveProperty("revocation_endpoint");
  });
  it("retires the operator bearer", async () => {
    const response = await exports.default.fetch(new Request("https://home-os.test/mcp", { method: "POST", headers: { authorization: "Bearer test-mcp-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(response.status).toBe(401);
  });
  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
  ])("keeps GET and HEAD discovery out of caches at %s", async (path) => {
    for (const method of ["GET", "HEAD"]) {
      const response = await exports.default.fetch(new Request(`https://home-os.test${path}`, {
        method,
        headers: { Origin: "https://client.example" },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://client.example");
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
  });
});

import { env } from "cloudflare:workers";
import { personalOAuth, realFetch, mcpRequest, tokenRequest, resource } from "./oauth-fixtures";
it("obtains personal resource-bound access through real DCR, explicit consent, PKCE and refresh", async () => {
  const oauth = await personalOAuth("viewer", "oauth-viewer");
  expect(oauth.tokens.expires_in).toBe(900);
  expect(oauth.tokens.refresh_token).toBeTruthy();
  const connection = await env.DB.prepare("SELECT * FROM mcp_connections WHERE member_id = ?").bind("oauth-viewer").first();
  expect(connection).toMatchObject({ status: "active", approved_role: "viewer", client_id: oauth.client.client_id });
  expect(connection!.provider_grant_id).toBeTruthy();
  const listed = await realFetch(mcpRequest(oauth.tokens.access_token));
  expect(listed.status).toBe(200);
  const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource });
  expect(refreshed.status).toBe(200);
});

import { afterEach, beforeEach, vi } from "vitest";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { oauthOptions, maintainRegistrations } from "../src/auth/oauth";
import { maintainConnections, resolveDelegatedAuthority } from "../src/auth/connections";
import { authorityPredicate } from "../src/auth/authority";
import { resetOAuthFixtures, startOAuth, approveOAuth, exchangeOAuth, browserProof, browserRequest, overriddenFetch, registerClient, data, oauthOrigin } from "./oauth-fixtures";

beforeEach(resetOAuthFixtures);
afterEach(() => vi.restoreAllMocks());
const helpers = () => getOAuthApi(oauthOptions(env, { fetch: () => new Response() }), env);
async function connectionCount(status = "active") { return (await env.DB.prepare("SELECT COUNT(*) AS count FROM mcp_connections WHERE status = ?").bind(status).first<{ count: number }>())!.count; }

describe("consent review boundaries", () => {
  it("refuses switched members and same-person browser-grant replacement", async () => {
    const first = await browserProof("member", "review-first"), second = await browserProof("viewer", "review-second"), started = await startOAuth(first);
    const switched = { ...second, cookie: `${second.cookie}; ${started.browser.cookie.split("; ").slice(1).join("; ")}` };
    expect((await realFetch(browserRequest(switched, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
    const replacement = await browserProof("member", first.memberId);
    expect((await realFetch(browserRequest({ ...replacement, cookie: `${replacement.cookie}; ${started.browser.cookie.split("; ").slice(1).join("; ")}` }, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
    expect(await connectionCount()).toBe(0);
  });
  it("requires another preview when the reviewed role changes", async () => {
    const browser = await browserProof("member", "review-role"), started = await startOAuth(browser);
    await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE id = ?").bind(browser.memberId).run();
    expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
    const preview = await realFetch(browserRequest(browser, `/api/v1/auth/consent/${started.id}`));
    expect(await data(preview)).toMatchObject({ approvedRole: "viewer", member: { role: "viewer" } });
    const cookies = preview.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    expect((await realFetch(browserRequest({ ...browser, cookie: `${browser.cookie}; ${cookies}` }, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(200);
  });
  it("D1 CAS permits one concurrent approval and refuses replay", async () => {
    const started = await startOAuth(await browserProof());
    const responses = await Promise.all([1, 2].map(() => realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}))));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await connectionCount()).toBe(1);
    expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
  });
  it("rejects expired intent, absent provider browser binding, cross-origin approval and changed payload", async () => {
    let started = await startOAuth(await browserProof());
    await env.DB.prepare("UPDATE mcp_consent_intents SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(started.id).run();
    expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
    started = await startOAuth(await browserProof());
    expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}, { Origin: "https://attacker.example" }))).status).toBe(403);
    expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, { memberId: "attacker", scope: "admin" }))).status).toBe(400);
    expect((await realFetch(browserRequest({ ...started.browser, cookie: started.browser.cookie.split("; ")[0]! }, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(400);
    expect(await connectionCount()).toBe(0);
  });
  it("deny uses the validated provider error redirect including issuer/state and never creates authority", async () => {
    const started = await startOAuth(await browserProof());
    const response = await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/deny`, {}));
    const denied = new URL((await data<{ redirectTo: string }>(response)).redirectTo);
    expect(denied.origin).toBe("https://client.example");
    expect(Object.fromEntries(denied.searchParams)).toMatchObject({ error: "access_denied", state: "fixture-state", iss: oauthOrigin });
    expect(response.headers.get("set-cookie")).toContain("__Host-oauth-consent-"); expect(response.headers.get("set-cookie")).not.toContain("homeos_session");
    expect(await connectionCount()).toBe(0);
  });
  it("consent preview does not renew Home OS cookies or expose provider handles/private session proofs", async () => {
    const browser = await browserProof(), started = await startOAuth(browser);
    const preview = await realFetch(browserRequest(browser, `/api/v1/auth/consent/${started.id}`));
    expect(preview.headers.get("set-cookie")).toContain("__Host-oauth-consent-"); expect(preview.headers.get("set-cookie")).not.toContain("homeos_session");
    expect(preview.headers.get("x-frame-options")).toBe("DENY");
    const json = await preview.text();
    for (const secret of [browser.cookie.split("=")[1]!, "consent_handle", "reviewed_session_hash", "password_hash", "refresh_token", "token_hash"]) expect(json).not.toContain(secret);
    expect(started.preview.capabilities).toContain("inventory_create");
  });
  it("protects the actual fresh consent/app HTML, including an installed old SW's bypass paths", async () => {
    for (const path of ["/api/oauth/consent?connect=" + "a".repeat(32), "/api/app", "/"]) {
      const response = await realFetch(new Request(oauthOrigin + path));
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/html");
      if (path !== "/") expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(await response.text()).toContain("Home OS");
    }
  });
});
describe("protocol security and continuing proof", () => {
  it.each([
    ["plain PKCE", { code_challenge_method: "plain" }], ["missing PKCE", { code_challenge: "", code_challenge_method: "" }],
    ["unknown scope", { scope: "home:admin" }], ["wrong resource", { resource: "https://attacker.example/mcp" }], ["unregistered redirect", { redirect_uri: "https://attacker.example/callback" }],
  ])("refuses %s before consent", async (_name, parameters) => {
    await expect(startOAuth(await browserProof(), { parameters })).rejects.toThrow("Authorize failed");
    expect((await env.DB.prepare("SELECT id FROM mcp_consent_intents").all()).results).toHaveLength(0);
  });
  it("rejects alternate issuers before provider handling while ordinary health/app stay usable", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/api/oauth/register", "/api/oauth/authorize", "/mcp"]) {
      const response = await realFetch(new Request(`https://alternate.workers.dev${path}`)); expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('"issuer":"https://alternate.workers.dev"');
    }
    expect((await realFetch(new Request("https://alternate.workers.dev/healthz"))).status).toBe(200);
    expect((await realFetch(new Request("https://alternate.workers.dev/"))).status).toBe(200);
  });
  it("code is bound to its client, PKCE verifier, redirect and resource", async () => {
    const started = await startOAuth(await browserProof()), approved = await approveOAuth(started), other = await registerClient();
    for (const overrides of [{ client_id: other.client_id }, { code_verifier: "W".repeat(64) }, { redirect_uri: "https://attacker.example/callback" }, { resource: "https://attacker.example/mcp" }]) {
      const response = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, redirect_uri: started.client.redirect_uris[0]!, code_verifier: started.verifier, code: approved.code, resource, ...overrides });
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: expect.stringMatching(/invalid_grant|invalid_target/) });
    }
    const tokens = await exchangeOAuth(started, approved.code); expect((await realFetch(mcpRequest(tokens.access_token))).status).toBe(200);
    const wrongRefreshClient = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id, resource });
    expect(await wrongRefreshClient.json()).toMatchObject({ error: "invalid_grant" });
  });
  it("access tokens expire after fifteen minutes but indefinite refresh and DCR clients survive former deadlines", async () => {
    const oauth = await personalOAuth("viewer", "indefinite-viewer"), now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 400 * 86_400_000);
    const fetch = overriddenFetch({});
    expect((await fetch(mcpRequest(oauth.tokens.access_token))).status).toBe(401);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: oauth.tokens.refresh_token, client_id: oauth.client.client_id, resource }, fetch);
    expect(refreshed.status).toBe(200); expect(await refreshed.json()).toMatchObject({ expires_in: 900, refresh_token: expect.any(String) });
    const grants = await helpers().listUserGrants(oauth.browser.memberId); expect(grants.items[0]!.expiresAt).toBeUndefined();
  });
  it("unexchanged approval ends after the provider's 600-second code window", async () => {
    const started = await startOAuth(await browserProof()), approved = await approveOAuth(started);
    await env.DB.prepare("UPDATE mcp_connections SET exchange_until = '2000-01-01T00:00:00.000Z'").run();
    const list = await data<{ connections: { status: string }[] }>(await realFetch(browserRequest(started.browser, "/api/v1/auth/connections")));
    expect(list.connections[0]!.status).toBe("ended");
    const exchange = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, code: approved.code, code_verifier: started.verifier, resource });
    expect(await exchange.json()).toMatchObject({ error: "invalid_grant" }); expect(await connectionCount()).toBe(0);
  });
  it("token binding outage permits retry of the same unconsumed authorization code", async () => {
    const started = await startOAuth(await browserProof()), approved = await approveOAuth(started);
    const failing = new Proxy(env.DB, { get(database, property) { if (property === "prepare") return (sql: string) => { if (sql.startsWith("UPDATE mcp_connections SET provider_grant_id")) throw new Error("D1 unavailable"); return database.prepare(sql); }; const value = Reflect.get(database, property); return typeof value === "function" ? value.bind(database) : value; } });
    const response = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, code: approved.code, code_verifier: started.verifier, resource }, overriddenFetch({ DB: failing }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await exchangeOAuth(started, approved.code)).access_token).toBeTruthy();
  });
  it("rejects optional RFC7009 and unsupported content types without misclassifying subject_token exchange", async () => {
    const optional = await tokenRequest({ token: "old-token", client_id: "does-not-matter" }); expect(await optional.json()).toMatchObject({ error: "unsupported_request" });
    for (const type of ["application/json", "text/plain", "multipart/form-data"]) {
      const response = await realFetch(new Request(`${oauthOrigin}/api/oauth/token`, { method: "POST", headers: { "content-type": type }, body: '{"token":"sensitive"}' }));
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    const subject = await tokenRequest({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: "opaque-subject_token-token=value", client_id: (await registerClient()).client_id });
    const result = await subject.json() as { error: string }; expect(result.error).not.toBe("unsupported_request");
    const tooLarge = await tokenRequest({ grant_type: "refresh_token", refresh_token: "x".repeat(17_000) }); expect(tooLarge.status).toBe(413);
  });
  it("preserves discovery CORS/capabilities and advertises no optional revocation endpoint", async () => {
    const response = await realFetch(new Request(`${oauthOrigin}/.well-known/oauth-authorization-server`, { headers: { Origin: "https://client.example" } }));
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(await response.json()).toMatchObject({ client_id_metadata_document_supported: true, registration_endpoint: `${oauthOrigin}/api/oauth/register`, scopes_supported: ["home:access"], grant_types_supported: ["authorization_code", "refresh_token"] });
  });
});

describe("bounded anonymous onboarding and temporary cleanup", () => {
  it("registration admission caps writes and retains only two fixed limiter keys", async () => {
    for (let index = 0; index < 20; index++) await registerClient();
    const rejected = await realFetch(new Request(`${oauthOrigin}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "over budget", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }) }));
    expect(rejected.status).toBe(429);
    const over = measuredFetch();
    await expect(registerClient(over.fetch)).rejects.toThrow("Registration failed 429");
    expect(over.requests).toEqual({ d1: 1, kv: 0 });
    expect((await helpers().listClients({ limit: 100 })).items).toHaveLength(20);
    expect((await env.DB.prepare("SELECT flow, attempts FROM oauth_admission").all()).results).toEqual([{ flow: "register", attempts: 20 }]);
    expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(20);
  });
  it("bounds total abandoned registration capacity across multiple limiter windows", async () => {
    for (let index = 0; index < 64; index++) { await env.DB.prepare("DELETE FROM oauth_admission").run(); await registerClient(); }
    await env.DB.prepare("DELETE FROM oauth_admission").run();
    await expect(registerClient()).rejects.toThrow("Registration failed 429");
    expect((await helpers().listClients({ limit: 100 })).items).toHaveLength(64);
    expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(64);
  });
  it("a bounded public client sweep removes old never-used registrations and preserves established indefinite clients", async () => {
    const abandoned = await registerClient(), established = await personalOAuth("viewer", "keep-client"), now = Date.now();
    await env.DB.prepare("UPDATE oauth_registrations SET created_at = '2000-01-01T00:00:00.000Z'").run();
    vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
    for (let index = 0; index < 4; index++) await maintainRegistrations(env, helpers());
    expect(await helpers().lookupClient(abandoned.client_id)).toBeNull(); expect(await helpers().lookupClient(established.client.client_id)).not.toBeNull();
    expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(0);
  });
  it("failed consent rows and expired intents are pruned in bounded ingress batches", async () => {
    const started = await startOAuth(await browserProof());
    await env.DB.prepare("UPDATE mcp_consent_intents SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    await maintainConnections(env, helpers());
    expect((await env.DB.prepare("SELECT id FROM mcp_consent_intents WHERE id = ?").bind(started.id).all()).results).toHaveLength(0);
  });
});

it("CIMD metadata identifies its domain and completes the real provider flow", async () => {
  const clientId = "https://metadata.example/oauth/client.json";
  const originalFetch = globalThis.fetch;
  let cimdRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === clientId) { cimdRequests++; return Response.json({ client_id: clientId, client_name: "Verified domain client", client_uri: "https://metadata.example", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { headers: { "Cache-Control": "max-age=60" } }); }
    return originalFetch(input, init);
  });
  const measured = measuredFetch(), fetch = measured.fetch;
  const assertBudget = () => {
    expect(measured.requests.d1 + measured.requests.kv + cimdRequests).toBeLessThanOrEqual(50);
    measured.requests.d1 = 0; measured.requests.kv = 0; cimdRequests = 0;
  };
  const started = await startOAuth(await browserProof("viewer", "cimd-viewer"), { client: { client_id: clientId, redirect_uris: ["https://client.example/callback"] }, fetch });
  expect(started.preview.client.clientDomain).toBe("metadata.example");
  expect(started.preview.client.clientName).toBe("Verified domain client");
  assertBudget();
  const approved = await approveOAuth(started, fetch); assertBudget();
  const tokens = await exchangeOAuth(started, approved.code, fetch); assertBudget();
  expect((await fetch(mcpRequest(tokens.access_token))).status).toBe(200); assertBudget();
});

it("any intervening role change invalidates review even when the old role is restored", async () => {
  const started = await startOAuth(await browserProof("member", "role-roundtrip"));
  await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE id = 'role-roundtrip'").run();
  await env.DB.prepare("UPDATE members SET role = 'member' WHERE id = 'role-roundtrip'").run();
  expect((await realFetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}))).status).toBe(409);
});
it("failure before provider grant creation preserves previous valid client authority", async () => {
  const old = await personalOAuth("member", "before-grant"), started = await startOAuth(old.browser, { client: old.client });
  const failingKV = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "put") return () => Promise.reject(new Error("KV unavailable")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
  const response = await overriddenFetch({ OAUTH_KV: failingKV })(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {}));
  expect(response.status).toBe(503); expect((await realFetch(mcpRequest(old.tokens.access_token))).status).toBe(200);
  expect((await env.DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ? AND status = 'failed'").bind(old.client.client_id).all()).results).toHaveLength(1);
});
it("the advertised metadata HEAD response stays bodyless with provider CORS", async () => {
  const response = await realFetch(new Request(`${oauthOrigin}/.well-known/oauth-authorization-server`, { method: "HEAD", headers: { Origin: "https://client.example" } }));
  expect(response.status).toBe(200); expect(await response.text()).toBe(""); expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
});
it("anonymous authorization creation rejects before more than sixty temporary intents and prunes expired rows", async () => {
  const browser = await browserProof(), client = await registerClient();
  for (let index = 0; index < 60; index++) await startOAuth(browser, { client });
  await expect(startOAuth(browser, { client })).rejects.toThrow("Authorize failed 429");
  expect((await env.DB.prepare("SELECT id FROM mcp_consent_intents").all()).results).toHaveLength(60);
  expect((await env.DB.prepare("SELECT flow FROM oauth_admission").all()).results).toHaveLength(2);
}, 15_000); // Sixty real authorize/consent-preview round trips, not one request.
it("uncertain registration-persistence failure retains capacity and is recoverable via public cleanup", async () => {
  const failingDB = new Proxy(env.DB, { get(db, property) { if (property === "prepare") return (sql: string) => { if (sql.startsWith("UPDATE oauth_registrations SET client_id = ? WHERE id = ?")) throw new Error("D1 unavailable after provider write"); return db.prepare(sql); }; const value = Reflect.get(db, property); return typeof value === "function" ? value.bind(db) : value; } });
  await expect(registerClient(overriddenFetch({ DB: failingDB }))).rejects.toThrow("Registration failed 503");
  expect((await env.DB.prepare("SELECT client_id FROM oauth_registrations").all()).results).toEqual([{ client_id: null }]);
  expect((await helpers().listClients()).items).toHaveLength(1);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
  await env.DB.prepare("UPDATE oauth_registrations SET created_at = '2000-01-01T00:00:00.000Z'").run();
  await maintainRegistrations(env, helpers());
  expect((await helpers().listClients()).items).toHaveLength(0);
  expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(0);
});
it("ordinary fallback app connection management works without minting an alternate OAuth issuer", async () => {
  const oauth = await personalOAuth("viewer", "fallback-member");
  const url = "https://alternate.workers.dev";
  const headers = { cookie: oauth.browser.cookie, Origin: url, "X-HomeOS-Member": oauth.browser.memberId, "content-type": "application/json" };
  const response = await realFetch(new Request(`${url}/api/v1/auth/connections`, { headers })); expect(response.status).toBe(200);
  const listed = await data<{ connections: { id: string; resource: string }[] }>(response);
  expect(listed.connections[0]!.resource).toBe(resource);
  const revoke = await realFetch(new Request(`${url}/api/v1/auth/connections/${listed.connections[0]!.id}/revoke`, { method: "POST", headers, body: "{}" })); expect(revoke.status).toBe(200);
  expect((await realFetch(mcpRequest(oauth.tokens.access_token))).status).toBe(401);
});
it("a post-callback provider KV failure never establishes authority and expires the incomplete connection", async () => {
  const started = await startOAuth(await browserProof()), approved = await approveOAuth(started);
  const failingKV = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "put") return () => Promise.reject(new Error("KV token persistence unavailable")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
  const response = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, code: approved.code, code_verifier: started.verifier, resource }, overriddenFetch({ OAUTH_KV: failingKV }));
  expect(response.status).toBe(503);
  const row = await env.DB.prepare("SELECT provider_grant_id, established_at FROM mcp_connections WHERE client_id = ?").bind(started.client.client_id).first();
  expect(row!.provider_grant_id).toBeTruthy(); expect(row!.established_at).toBeNull();
  const connection = await env.DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ?").bind(started.client.client_id).first<{ id: string }>();
  expect(await resolveDelegatedAuthority(env, connection!.id, started.client.client_id, started.browser.memberId, resource)).toBeNull();
  const predicate = authorityPredicate({ householdId: "home", actorId: started.browser.memberId, actorType: "mcp", source: "mcp", operationId: "unconfirmed-test",
    authority: { householdId: "home", memberId: started.browser.memberId, role: "owner", proof: { kind: "delegated", connectionId: connection!.id, credentialVersion: 1, ceiling: "owner" } } }, "inventory_list");
  expect(await env.DB.prepare(`SELECT ${predicate.sql} AS admitted`).bind(...predicate.values).first()).toMatchObject({ admitted: 0 });
  await env.DB.prepare("UPDATE mcp_connections SET exchange_until = '2000-01-01T00:00:00.000Z'").run();
  await maintainConnections(env, helpers());
  expect(await env.DB.prepare("SELECT status FROM mcp_connections WHERE client_id = ?").bind(started.client.client_id).first()).toMatchObject({ status: "failed" });
});
it("initial token delivery fails closed if final D1 confirmation cannot commit", async () => {
  const started = await startOAuth(await browserProof()), approved = await approveOAuth(started);
  const failingDB = new Proxy(env.DB, { get(db, property) { if (property === "prepare") return (sql: string) => { if (sql.startsWith("UPDATE mcp_connections SET established_at")) throw new Error("D1 confirmation unavailable"); return db.prepare(sql); }; const value = Reflect.get(db, property); return typeof value === "function" ? value.bind(db) : value; } });
  const response = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, code: approved.code, code_verifier: started.verifier, resource }, overriddenFetch({ DB: failingDB }));
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
  expect(await env.DB.prepare("SELECT established_at FROM mcp_connections WHERE client_id = ?").bind(started.client.client_id).first()).toMatchObject({ established_at: null });
});

import { measuredFetch } from "./oauth-fixtures";
it("real public-helper cleanup remains bounded after many refreshes, and terminal refusal stays invalid_grant", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const oauth = await personalOAuth("viewer", "many-refreshes");
  let refreshToken = oauth.tokens.refresh_token;
  for (let index = 0; index < 25; index++) {
    const response = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: refreshToken, resource });
    expect(response.status).toBe(200); refreshToken = (await response.json() as { refresh_token: string }).refresh_token;
  }
  const connection = await env.DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ?").bind(oauth.client.client_id).first<{ id: string }>();
  const revoke = measuredFetch();
  expect((await revoke.fetch(browserRequest(oauth.browser, `/api/v1/auth/connections/${connection!.id}/revoke`, {}))).status).toBe(200);
  expect(revoke.requests.d1 + revoke.requests.kv).toBeLessThanOrEqual(50);
  expect(revoke.requests.kv).toBeLessThanOrEqual(6);
  const terminal = measuredFetch();
  const response = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: refreshToken, resource }, terminal.fetch);
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  expect(terminal.requests.d1 + terminal.requests.kv).toBeLessThanOrEqual(50);
  expect(terminal.requests.kv).toBeLessThanOrEqual(20);
  console.info("OAuth heavy cleanup binding costs", { revoke: revoke.requests, terminal: terminal.requests });
  for (const call of warn.mock.calls) {
    const output = call.map(String).join(" ");
    expect(output).not.toContain(oauth.tokens.access_token); expect(output).not.toContain(oauth.tokens.refresh_token); expect(output).not.toContain(refreshToken);
  }
});
it("protocol onboarding requests include bounded D1 and KV costs", async () => {
  const browser = await browserProof(), register = measuredFetch(), client = await registerClient(register.fetch);
  expect(register.requests.d1 + register.requests.kv).toBeLessThanOrEqual(50);
  const begin = measuredFetch(), started = await startOAuth(browser, { client, fetch: begin.fetch });
  // startOAuth contains two invocations: authorization and preview. Each also fits separately below.
  expect(begin.requests.d1 + begin.requests.kv).toBeLessThanOrEqual(50);
  const approve = measuredFetch(), approved = await approveOAuth(started, approve.fetch);
  expect(approve.requests.d1 + approve.requests.kv).toBeLessThanOrEqual(50);
  const exchange = measuredFetch(); await exchangeOAuth(started, approved.code, exchange.fetch);
  expect(exchange.requests.d1 + exchange.requests.kv).toBeLessThanOrEqual(50);
  console.info("OAuth onboarding binding costs", { register: register.requests, authorizeAndPreview: begin.requests, approve: approve.requests, exchange: exchange.requests });
});
it("a completed public sweep recovers all64 reservations after registration KV never persisted", async () => {
  const noWrite = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "put") return () => Promise.reject(new Error("KV unavailable before persistence")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
  const fetch = overriddenFetch({ OAUTH_KV: noWrite });
  for (let index = 0; index < 64; index++) {
    await env.DB.prepare("DELETE FROM oauth_admission").run();
    await expect(registerClient(fetch)).rejects.toThrow("Registration failed 503");
  }
  expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(64);
  expect((await helpers().listClients()).items).toHaveLength(0);
  await env.DB.prepare("UPDATE oauth_registrations SET created_at = '2000-01-01T00:00:00.000Z'").run();
  await maintainRegistrations(env, helpers());
  expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(0);
  await env.DB.prepare("DELETE FROM oauth_admission").run();
  const late = await registerClient(); expect(late.client_id).toBeTruthy();
  // Simulate a late-visible provider client after its unmatched reservation was released.
  await env.DB.prepare("DELETE FROM oauth_registrations WHERE client_id = ?").bind(late.client_id).run();
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
  await maintainRegistrations(env, helpers());
  expect(await helpers().lookupClient(late.client_id)).toBeNull();
  expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(0);
});
it("bound but never-confirmed exchange does not permanently protect abandoned DCR client", async () => {
  const started = await startOAuth(await browserProof()), approved = await approveOAuth(started);
  const failingKV = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "put") return () => Promise.reject(new Error("KV unavailable before tokens")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
  expect((await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, code: approved.code, code_verifier: started.verifier, resource }, overriddenFetch({ OAUTH_KV: failingKV }))).status).toBe(503);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
  await env.DB.prepare("UPDATE mcp_connections SET exchange_until = '2000-01-01T00:00:00.000Z'").run();
  await maintainRegistrations(env, helpers());
  expect(await helpers().lookupClient(started.client.client_id)).toBeNull();
});
it("failed sweep page keeps its cursor and unmatched reservation until a successful full scan", async () => {
  const client = await registerClient();
  await env.DB.prepare("UPDATE oauth_registrations SET client_id = NULL, created_at = '2000-01-01T00:00:00.000Z'").run();
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 2 * 86_400_000);
  const publicHelpers = helpers();
  const fail = { ...publicHelpers, deleteClient: async () => { throw new Error("cleanup unavailable"); } };
  // Preserve the actual helper prototype; only the public cleanup method fails.
  const failing = new Proxy(publicHelpers, { get(target, property) { if (property === "deleteClient") return fail.deleteClient; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } });
  await expect(maintainRegistrations(env, failing, publicHelpers)).rejects.toThrow("cleanup unavailable");
  expect(await env.DB.prepare("SELECT cursor, started_at IS NOT NULL AS started FROM oauth_client_sweep").first()).toMatchObject({ cursor: null, started: 1 });
  expect((await env.DB.prepare("SELECT id FROM oauth_registrations").all()).results).toHaveLength(1);
  expect(await publicHelpers.lookupClient(client.client_id)).not.toBeNull();
});
