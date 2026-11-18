import OAuthProvider, { AuthorizationError, OAuthError, getOAuthApi, type OAuthHelpers, type OAuthProviderOptions, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { handleMcpRequest } from "../mcp/routes";
import { resolveDelegatedAuthority } from "./connections";

export function canonicalResource(env: Env): string {
  const configured = new URL(env.HOMEOS_MCP_RESOURCE);
  if (configured.protocol !== "https:" || configured.pathname !== "/mcp" || configured.search || configured.hash || configured.username || configured.password) throw new Error("Invalid trusted MCP resource configuration");
  return configured.href;
}
export function oauthHelpers(env: Env): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("OAuth provider is unavailable");
  return env.OAUTH_PROVIDER;
}
export function oauthMaintenanceHelpers(env: Env): OAuthHelpers {
  return env.OAUTH_MAINTENANCE_PROVIDER ?? oauthHelpers(env);
}
/** Count binding calls, never inspect a provider key or opaque credential. */
function boundedKV(namespace: KVNamespace, limit: number): { namespace: KVNamespace; pending: Promise<unknown>[] } {
  let used = 0;
  const pending: Promise<unknown>[] = [];
  const bounded = new Proxy(namespace, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (++used > limit) throw new Error("OAuth KV request budget exhausted");
      const result = Promise.resolve(Reflect.apply(value, target, args));
      pending.push(result);
      return result;
    };
  } });
  return { namespace: bounded, pending };
}
export async function bindProviderGrant(options: TokenExchangeCallbackOptions<Env>): Promise<{ established: boolean }> {
  const { env } = options, id: unknown = options.props?.connectionId;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || options.resource !== canonicalResource(env) || options.clientId !== options.subjectClientId || !options.scope.includes("home:access")) {
    throw new OAuthError("invalid_grant", { description: "This personal connection is no longer valid." });
  }
  let bound: { id: string; established_at: string | null } | null;
  try {
    bound = await env.DB.prepare(`UPDATE mcp_connections SET provider_grant_id = ? WHERE id = ? AND status = 'active'
      AND member_id = ? AND household_id = ? AND client_id = ? AND resource = ?
      AND (provider_grant_id IS NULL OR provider_grant_id = ?) AND (established_at IS NOT NULL OR exchange_until > ?)
      AND EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
        WHERE m.id = mcp_connections.member_id AND m.household_id = mcp_connections.household_id AND m.archived_at IS NULL AND a.credential_version = mcp_connections.credential_version)
      RETURNING id, established_at`)
      .bind(options.grantId, id, options.userId, env.HOMEOS_DEFAULT_HOUSEHOLD_ID, options.clientId, options.resource, options.grantId, new Date().toISOString()).first<{ id: string; established_at: string | null }>();
  } catch {
    throw new OAuthError("temporarily_unavailable", { description: "Home OS access storage is temporarily unavailable. Retry shortly.", statusCode: 503, headers: { "Retry-After": "5" } });
  }
  if (!bound) throw new OAuthError("invalid_grant", { description: "This personal connection ended. Connect again from Home OS." });
  return { established: bound.established_at !== null };
}

/** Fixed-cardinality global budgets apply before the provider stores anonymous clients/intents. */
export async function admitOAuthIngress(env: Env, flow: "register" | "authorize"): Promise<void> {
  const windowStart = Math.floor(Date.now() / 900_000), limit = flow === "register" ? 20 : 60;
  const result = await env.DB.prepare(`INSERT INTO oauth_admission (flow, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT (flow) DO UPDATE SET window_start = excluded.window_start,
      attempts = CASE WHEN oauth_admission.window_start = excluded.window_start THEN oauth_admission.attempts + 1 ELSE 1 END
    WHERE oauth_admission.window_start <> excluded.window_start OR oauth_admission.attempts < ? RETURNING attempts`)
    .bind(flow, windowStart, limit).first();
  if (!result) throw new OAuthError("temporarily_unavailable", { description: "Too many connection attempts. Try again later.", statusCode: 429, headers: { "Retry-After": "900" } });
}
function protocolError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
async function boundedBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) { await reader.cancel(); return null; }
    chunks.push(next.value);
  }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(data);
}
type RegistrationState = { id?: string; maintain?: () => Promise<void> };
type AppHandler = { fetch(request: Request, env: Env, context: ExecutionContext): Response | Promise<Response> };
export function oauthOptions(env: Env, fallback: AppHandler, registration?: RegistrationState, exchange?: { connectionId?: string; grantId?: string }): OAuthProviderOptions<Env> {
  const resource = canonicalResource(env), origin = new URL(resource).origin;
  return {
    apiRoute: "/mcp",
    apiHandler: { async fetch(request, bindings, context) {
      const verified = context as ExecutionContext & { props?: { connectionId?: unknown }; auth?: { clientId: string; userId: string; scope: string[] } };
      try {
        const auth = verified.auth;
        const authority = auth?.scope.includes("home:access") ? await resolveDelegatedAuthority(bindings, verified.props?.connectionId, auth.clientId, auth.userId, resource) : null;
        if (!authority) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "content-type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`, "Cache-Control": "no-store" } });
        return handleMcpRequest(request, bindings, authority, auth!.clientId);
      } catch { return protocolError("temporarily_unavailable", "Home OS access storage is temporarily unavailable.", 503); }
    } },
    defaultHandler: fallback,
    authorizeEndpoint: `${origin}/api/oauth/authorize`, tokenEndpoint: `${origin}/api/oauth/token`, clientRegistrationEndpoint: `${origin}/api/oauth/register`,
    resourceMetadata: { resource, authorization_servers: [origin], resource_name: "Home OS" },
    scopesSupported: ["home:access"], requiredScopes: ["home:access"], accessTokenTTL: 900,
    refreshTokenTTL: undefined, clientRegistrationTTL: undefined, clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: async options => {
      const binding = await bindProviderGrant(options);
      if (exchange && !binding.established) {
        exchange.connectionId = options.props.connectionId;
        exchange.grantId = options.grantId;
      }
    },
    clientRegistrationCallback: async () => {
      try {
        await admitOAuthIngress(env, "register");
        await registration?.maintain?.().catch(() => {});
        const id = crypto.randomUUID().replaceAll("-", "");
        const reserved = await env.DB.prepare(`INSERT INTO oauth_registrations (id, created_at)
          SELECT ?, ? WHERE (SELECT COUNT(*) FROM oauth_registrations) < 64 RETURNING id`)
          .bind(id, new Date().toISOString()).first();
        if (!reserved) return { code: "temporarily_unavailable", description: "Connection registration is busy. Try again later.", status: 429 };
        if (registration) registration.id = id;
      }
      catch (error) {
        if (error instanceof OAuthError) return { code: error.code, description: error.description, status: error.statusCode };
        return { code: "temporarily_unavailable", description: "Home OS authorization is temporarily unavailable.", status: 503 };
      }
    },
    // Deliberately avoid logging client input, codes, tokens, or provider-internal diagnostics.
    onError: () => {},
  };
}

/** One public-helper client page per onboarding request; never touches established clients. */
export async function maintainRegistrations(env: Env, helpers: OAuthHelpers, verification: OAuthHelpers = helpers): Promise<void> {
  const now = new Date().toISOString(), cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const state = await env.DB.prepare(`UPDATE oauth_client_sweep SET started_at = COALESCE(started_at, ?)
    WHERE id = 1 RETURNING cursor, started_at`).bind(now).first<{ cursor: string | null; started_at: string }>();
  if (!state) return;
  // Recover a cleanup that deleted its client before a later public-helper/storage failure.
  const interrupted = await env.DB.prepare(`SELECT id, client_id FROM oauth_registrations
    WHERE cleanup_nonce IS NOT NULL AND cleanup_started_at < ? ORDER BY created_at LIMIT 1`)
    .bind(new Date(Date.now() - 300_000).toISOString()).first<{ id: string; client_id: string }>();
  if (interrupted && !(await verification.lookupClient(interrupted.client_id))) {
    await env.DB.prepare("DELETE FROM oauth_registrations WHERE id = ? AND cleanup_nonce IS NOT NULL").bind(interrupted.id).run();
  }
  const clients = await helpers.listClients({ limit: 1, ...(state.cursor ? { cursor: state.cursor } : {}) });
  const client = clients.items[0];
  if (client && client.registrationDate !== undefined && client.registrationDate * 1000 <= Date.parse(cutoff)) {
    // A confirmed continuing grant survives indefinitely. Unconfirmed attempts only
    // protect their bounded code-exchange window, even after the grant ID was bound.
    const protection = `EXISTS (SELECT 1 FROM mcp_connections WHERE client_id = ?
      AND (established_at IS NOT NULL OR (status IN ('pending','active') AND exchange_until > ?)))`;
    const protectedClient = await env.DB.prepare(`SELECT ${protection} AS protected`).bind(client.clientId, now).first<{ protected: number }>();
    if (!protectedClient?.protected) {
      await env.DB.prepare(`UPDATE oauth_registrations SET client_id = ? WHERE id = (SELECT id FROM oauth_registrations
        WHERE client_id IS NULL AND created_at < ? ORDER BY created_at LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM oauth_registrations WHERE client_id = ?)`).bind(client.clientId, cutoff, client.clientId).run();
      // A late-visible orphan can be claimed without depending on private provider keys.
      await env.DB.prepare(`INSERT INTO oauth_registrations (id, client_id, created_at)
        SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM oauth_registrations WHERE client_id = ?)
        AND (SELECT COUNT(*) FROM oauth_registrations) < 64`)
        .bind(crypto.randomUUID(), client.clientId, cutoff, client.clientId).run();
      const nonce = crypto.randomUUID();
      const claimed = await env.DB.prepare(`UPDATE oauth_registrations SET cleanup_nonce = ?, cleanup_started_at = ?
        WHERE client_id = ? AND (cleanup_nonce IS NULL OR cleanup_started_at < ?) AND NOT ${protection} RETURNING id`)
        .bind(nonce, now, client.clientId, new Date(Date.now() - 300_000).toISOString(), client.clientId, now).first<{ id: string }>();
      if (!claimed) return; // A failed/competing page is retried before cursor advancement.
      try { await helpers.deleteClient(client.clientId); }
      catch (error) { if (await verification.lookupClient(client.clientId)) throw error; }
      await env.DB.prepare("DELETE FROM oauth_registrations WHERE id = ? AND cleanup_nonce = ?").bind(claimed.id, nonce).run();
    }
  }
  if (clients.cursor) {
    await env.DB.prepare("UPDATE oauth_client_sweep SET cursor = ? WHERE id = 1 AND cursor IS ? AND started_at = ?")
      .bind(clients.cursor, state.cursor, state.started_at).run();
  } else {
    // Only a successfully completed full public scan releases mature unmatched slots.
    // Keep a consistency margin before the sweep began; incomplete/failed pages never reap.
    const stableCutoff = new Date(Date.parse(state.started_at) - 120_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM oauth_registrations WHERE client_id IS NULL AND created_at < ? AND created_at < ?
        AND EXISTS (SELECT 1 FROM oauth_client_sweep WHERE id = 1 AND cursor IS ? AND started_at = ?)`)
        .bind(cutoff, stableCutoff, state.cursor, state.started_at),
      env.DB.prepare("UPDATE oauth_client_sweep SET cursor = NULL, started_at = NULL WHERE id = 1 AND cursor IS ? AND started_at = ?")
        .bind(state.cursor, state.started_at),
    ]);
  }
}

export function createOAuthFetch(fallback: AppHandler): (request: Request, env: Env, context: ExecutionContext) => Promise<Response> {
  return async (original, env, context) => {
    const url = new URL(original.url), path = url.pathname;
    const oauthPath = path.startsWith("/api/oauth/") || path.startsWith("/.well-known/oauth-") || path === "/mcp" || path.startsWith("/mcp/");
    const needsHelpers = /^\/api\/v1\/auth\/(consent|connections)(\/|$)/.test(path);
    if (!oauthPath && !needsHelpers) return fallback.fetch(original, env, context);
    const origin = new URL(canonicalResource(env)).origin;
    const consentApi = /^\/api\/v1\/auth\/consent(?:\/|$)/.test(path);
    if ((oauthPath || consentApi) && url.origin !== origin) return protocolError("invalid_request", "Use the canonical Home OS authorization origin.");
    let request = original;
    const kvBudget = boundedKV(env.OAUTH_KV, 20);
    try {
      if (path === "/api/oauth/authorize") {
        if (original.method !== "GET" || original.url.length > 8192) return protocolError("invalid_request", "Invalid authorization request.");
        await admitOAuthIngress(env, "authorize");
      }
      if (["/api/oauth/token", "/api/oauth/register"].includes(path) && original.method === "POST") {
        if (path.endsWith("/token") && original.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return protocolError("invalid_request", "Content-Type must be application/x-www-form-urlencoded.");
        const body = await boundedBody(original, 16384);
        if (body === null) return protocolError("invalid_request", "The OAuth request is too large.", 413);
        if (path.endsWith("/token")) {
          const form = new URLSearchParams(body);
          // Match the published form parser's truthy top-level token classification exactly.
          if (form.get("token") && !form.get("grant_type")) return protocolError("unsupported_request", "End connections from Home OS or its connection tools.");
        }
        request = new Request(original, { body });
      }
      // The provider installs its public helper binding on a request-local environment object.
      const bindings: Env = { ...env, OAUTH_KV: kvBudget.namespace, OAUTH_PROVIDER: undefined, OAUTH_MAINTENANCE_PROVIDER: undefined };
      const registration: RegistrationState = {};
      const exchange: { connectionId?: string; grantId?: string } = {};
      const options = oauthOptions(bindings, fallback, registration, exchange);
      const helpers = getOAuthApi(options, bindings);
      const maintenance = getOAuthApi(options, { ...bindings, OAUTH_KV: boundedKV(bindings.OAUTH_KV, 6).namespace });
      bindings.OAUTH_MAINTENANCE_PROVIDER = maintenance;
      registration.maintain = () => maintainRegistrations(bindings, maintenance, helpers);
      if (path === "/api/oauth/authorize") await maintainRegistrations(bindings, maintenance, helpers).catch(() => {});
      const provider = new OAuthProvider(options);
      const response = await provider.fetch(request, bindings, context);
      if (path === "/api/oauth/token" && response.ok && exchange.connectionId && exchange.grantId) {
        // The published callback precedes KV persistence. Confirm only after that succeeds,
        // before any initial token is delivered; incomplete exchanges keep the 600s window.
        const confirmed = await bindings.DB.prepare(`UPDATE mcp_connections SET established_at = COALESCE(established_at, ?)
          WHERE id = ? AND provider_grant_id = ? AND status = 'active' AND exchange_until > ?
          AND EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id WHERE m.id = mcp_connections.member_id
            AND m.household_id = mcp_connections.household_id AND m.archived_at IS NULL AND a.credential_version = mcp_connections.credential_version)
          RETURNING id`).bind(new Date().toISOString(), exchange.connectionId, exchange.grantId, new Date().toISOString()).first();
        if (!confirmed) return protocolError("invalid_grant", "This personal connection ended. Connect again from Home OS.");
      }
      if (path === "/api/oauth/register" && response.status === 201 && registration.id) {
        const result = await response.clone().json() as { client_id: string };
        // If this write fails the client gets a retryable error; its reserved capacity stays held.
        const recorded = await bindings.DB.prepare("UPDATE oauth_registrations SET client_id = ? WHERE id = ? AND client_id IS NULL RETURNING id")
          .bind(result.client_id, registration.id).first();
        if (!recorded) {
          await maintenance.deleteClient(result.client_id).catch(() => {});
          return protocolError("temporarily_unavailable", "This registration expired. Start again.", 503);
        }
      }
      if (path.startsWith("/.well-known/oauth-") && response.ok) {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
          const metadata = await response.json() as Record<string, unknown>;
          delete metadata.revocation_endpoint; delete metadata.revocation_endpoint_auth_methods_supported; delete metadata.revocation_endpoint_auth_signing_alg_values_supported;
          return new Response(JSON.stringify(metadata), { status: response.status, headers });
        }
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    } catch (error) {
      if (error instanceof AuthorizationError) return error.redirectTo ? new Response(null, { status: 302, headers: { Location: error.redirectTo, "Cache-Control": "no-store" } }) : protocolError(error.code, error.description);
      if (error instanceof OAuthError) return Response.json({ error: error.code, error_description: error.description }, { status: error.statusCode, headers: { ...error.headers, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
      return protocolError("temporarily_unavailable", "Home OS authorization is temporarily unavailable.", 503);
    } finally {
      // Public cleanup helpers may issue parallel deletes before their budget refuses
      // the next call. Settle the calls already issued before returning this response.
      await Promise.allSettled(kvBudget.pending);
    }
  };
}
