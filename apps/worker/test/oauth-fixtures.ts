import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { digest } from "../src/auth/crypto";
import type { Role } from "../src/auth/permissions";
import type { Env } from "../src/env";
import type { ConsentPreview } from "../src/auth/consent";

export const oauthOrigin = "https://home-os.test";
export const resource = `${oauthOrigin}/mcp`;
export type FetchWorker = (request: Request) => Promise<Response>;
export const realFetch: FetchWorker = request => exports.default.fetch(request);
export function overriddenFetch(overrides: Partial<Env>): FetchWorker {
  return async request => {
    const context = createExecutionContext();
    const response = await worker.fetch(request, { ...env, ...overrides }, context);
    await waitOnExecutionContext(context);
    return response;
  };
}
export interface BrowserProof { memberId: string; cookie: string; sessionId: string; }
export async function browserProof(role: Role = "owner", memberId = "local-owner"): Promise<BrowserProof> {
  const now = new Date().toISOString(), sessionId = crypto.randomUUID().replaceAll("-", ""), token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES (?, 'home', ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET role = excluded.role, archived_at = NULL`).bind(memberId, memberId, `${memberId}@home-os.test`, role, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES (?, ?, 'not-a-password-login-fixture', ?)").bind(memberId, `${memberId}@home-os.test`, now),
    env.DB.prepare("INSERT INTO auth_sessions (token_hash, public_id, member_id, credential_version, expires_at, created_at, permanent) SELECT ?, ?, member_id, credential_version, ?, ?, 1 FROM auth_accounts WHERE member_id = ?")
      .bind(await digest(token), sessionId, "2099-01-01T00:00:00.000Z", now, memberId),
  ]);
  return { memberId, sessionId, cookie: `homeos_session=${token}` };
}
export function browserRequest(browser: BrowserProof, path: string, body?: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`${oauthOrigin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: browser.cookie, Origin: oauthOrigin, "X-HomeOS-Member": browser.memberId, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function data<T>(response: Response): Promise<T> {
  const payload = await response.json() as { ok: boolean; data: T; error?: unknown };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload.error ?? payload)}`);
  return payload.data;
}
export function addCookies(browser: BrowserProof, response: Response): BrowserProof {
  return { ...browser, cookie: [browser.cookie, ...response.headers.getSetCookie().map(value => value.split(";")[0]!)].join("; ") };
}
export async function registerClient(fetch: FetchWorker = realFetch): Promise<{ client_id: string; redirect_uris: string[] }> {
  const response = await fetch(new Request(`${oauthOrigin}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Personal test client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) }));
  const client = await response.json() as { client_id: string; redirect_uris: string[] };
  if (response.status !== 201) throw new Error(`Registration failed ${response.status}: ${JSON.stringify(client)}`);
  return client;
}
export interface StartedOAuth { id: string; browser: BrowserProof; client: { client_id: string; redirect_uris: string[] }; verifier: string; preview: ConsentPreview; }
export async function startOAuth(browser: BrowserProof, input: { client?: { client_id: string; redirect_uris: string[] }; fetch?: FetchWorker; parameters?: Record<string, string> } = {}): Promise<StartedOAuth> {
  const fetch = input.fetch ?? realFetch, client = input.client ?? await registerClient(fetch), verifier = "V".repeat(64);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const authorize = await fetch(new Request(`${oauthOrigin}/api/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, scope: "home:access", code_challenge: challenge, code_challenge_method: "S256", resource, state: "fixture-state", ...input.parameters })}`, { redirect: "manual" }));
  if (authorize.status !== 302 || !authorize.headers.get("location")?.includes("connect=")) throw new Error(`Authorize failed ${authorize.status}: ${authorize.headers.get("location") ?? await authorize.text()}`);
  const id = new URL(authorize.headers.get("location")!, oauthOrigin).searchParams.get("connect")!;
  const previewResponse = await fetch(browserRequest(browser, `/api/v1/auth/consent/${id}`));
  const preview = await data<ConsentPreview>(previewResponse);
  return { id, browser: addCookies(browser, previewResponse), client, verifier, preview };
}
export async function approveOAuth(started: StartedOAuth, fetch: FetchWorker = realFetch): Promise<{ redirectTo: string; code: string }> {
  const result = await data<{ redirectTo: string }>(await fetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {})));
  return { ...result, code: new URL(result.redirectTo).searchParams.get("code")! };
}
export interface OAuthTokens { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string; }
export async function tokenRequest(fields: Record<string, string>, fetch: FetchWorker = realFetch): Promise<Response> {
  return fetch(new Request(`${oauthOrigin}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) }));
}
export async function exchangeOAuth(started: StartedOAuth, code: string, fetch: FetchWorker = realFetch): Promise<OAuthTokens> {
  const response = await tokenRequest({ grant_type: "authorization_code", client_id: started.client.client_id, redirect_uri: started.client.redirect_uris[0]!, resource, code, code_verifier: started.verifier }, fetch);
  const tokens = await response.json() as OAuthTokens;
  if (!response.ok) throw new Error(`Exchange failed ${response.status}: ${JSON.stringify(tokens)}`);
  return tokens;
}
/** Reusable actual DCR/consent/PKCE flow: never mint bypass credentials. */
export async function personalOAuth(role: Role = "owner", memberId = "local-owner", input: { client?: { client_id: string; redirect_uris: string[] }; fetch?: FetchWorker } = {}) {
  const browser = await browserProof(role, memberId), started = await startOAuth(browser, input), approved = await approveOAuth(started, input.fetch);
  const tokens = await exchangeOAuth(started, approved.code, input.fetch);
  return { ...started, ...approved, tokens };
}
export function mcpRequest(accessToken: string, method = "tools/list", params?: unknown): Request {
  return new Request(resource, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }) });
}

/** Whole test namespace reset; it does not depend on the provider's private key layout. */
export async function resetOAuthFixtures(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({ ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) await env.OAUTH_KV.delete(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_connections"), env.DB.prepare("DELETE FROM mcp_consent_intents"), env.DB.prepare("DELETE FROM oauth_registrations"),
    env.DB.prepare("DELETE FROM oauth_admission"), env.DB.prepare("UPDATE oauth_client_sweep SET cursor = NULL, started_at = NULL"),
    env.DB.prepare("DELETE FROM audit_events"), env.DB.prepare("DELETE FROM household_command_receipts"), env.DB.prepare("DELETE FROM processed_operations"), env.DB.prepare("DELETE FROM mutation_guards"),
    env.DB.prepare("DELETE FROM auth_sessions"), env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("UPDATE members SET role = 'owner', archived_at = NULL WHERE id = 'local-owner'"),
  ]);
}

/** Conservative binding accounting: every D1 statement in a batch counts separately. */
export function measuredFetch(): { fetch: FetchWorker; requests: { d1: number; kv: number } } {
  const requests = { d1: 0, kv: 0 }, originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(Reflect.apply(target.bind, target, values));
      const value = Reflect.get(target, property);
      if (["all", "first", "run", "raw"].includes(String(property))) return (...args: unknown[]) => { requests.d1++; return Reflect.apply(value, target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); return proxy;
  };
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (property === "batch") return (statements: D1PreparedStatement[]) => { requests.d1 += statements.length; return target.batch(statements.map(statement => originals.get(statement) ?? statement)); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  const kv = new Proxy(env.OAUTH_KV, { get(target, property) {
    const value = Reflect.get(target, property); if (typeof value !== "function") return value;
    return (...args: unknown[]) => { requests.kv++; return Reflect.apply(value, target, args); };
  } });
  return { fetch: overriddenFetch({ DB: database, OAUTH_KV: kv }), requests };
}
