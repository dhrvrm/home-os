import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectionAccessService, resolveDelegatedAuthority } from "../src/auth/connections";
import { SessionAccessService } from "../src/auth/session-access";
import { authorityPredicate, authorizedBatch } from "../src/auth/authority";
import { capabilities } from "../src/auth/permissions";
import { digest } from "../src/auth/crypto";
import type { CommandContext } from "../src/platform/context";
import { revokeMemberGrants } from "../src/auth/session-policy";
import { resetOAuthFixtures, personalOAuth, realFetch, mcpRequest, browserRequest, browserProof, data, tokenRequest, resource, overriddenFetch, startOAuth, approveOAuth, exchangeOAuth } from "./oauth-fixtures";
import { bindProviderGrant, oauthOptions } from "../src/auth/oauth";
import { getOAuthApi, GrantType } from "@cloudflare/workers-oauth-provider";

beforeEach(resetOAuthFixtures);

async function delegated(oauth: Awaited<ReturnType<typeof personalOAuth>>, tool = "connections_revoke"): Promise<CommandContext> {
  const row = await env.DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ? AND status = 'active'").bind(oauth.client.client_id).first<{ id: string }>();
  const authority = await resolveDelegatedAuthority(env, row!.id, oauth.client.client_id, oauth.browser.memberId, resource);
  return { authority: authority!, householdId: "home", actorId: oauth.browser.memberId, actorType: "mcp", source: "mcp", operationId: crypto.randomUUID(), mcpClientId: oauth.client.client_id, mcpTool: tool };
}
function failDatabase(match: (sql: string) => boolean): D1Database {
  return new Proxy(env.DB, { get(database, property) {
    if (property === "prepare") return (sql: string) => { if (match(sql)) throw new Error("Simulated D1 outage"); return database.prepare(sql); };
    const value = Reflect.get(database, property); return typeof value === "function" ? value.bind(database) : value;
  } });
}
describe("durable personal connection authority", () => {
  it("keeps the consent ceiling through promotion and refresh, applies demotion immediately", async () => {
    await browserProof();
    const oauth = await personalOAuth("member", "ceiling-member"), context = await delegated(oauth);
    await env.DB.prepare("UPDATE members SET role = 'owner' WHERE id = ?").bind(context.actorId).run();
    let authority = await resolveDelegatedAuthority(env, context.authority!.proof.kind === "delegated" ? context.authority!.proof.connectionId : "", oauth.client.client_id, context.actorId, resource);
    expect(capabilities({ ...authority!, kind: "delegated", ceiling: authority!.proof.kind === "delegated" ? authority!.proof.ceiling : undefined })).not.toContain("members_update");
    const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource }); expect(refreshed.status).toBe(200);
    expect(await env.DB.prepare("SELECT approved_role FROM mcp_connections WHERE client_id = ?").bind(oauth.client.client_id).first()).toMatchObject({ approved_role: "member" });
    await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE id = ?").bind(context.actorId).run();
    const predicate = authorityPredicate(context, "inventory_create");
    expect(await env.DB.prepare(`SELECT ${predicate.sql} AS admitted`).bind(...predicate.values).first()).toMatchObject({ admitted: 0 });
    authority = await resolveDelegatedAuthority(env, context.authority!.proof.kind === "delegated" ? context.authority!.proof.connectionId : "", oauth.client.client_id, context.actorId, resource);
    expect(authority!.role).toBe("viewer");
  });
  it("rejects mutation acceptance after revocation, including a cached previously admitted context", async () => {
    const oauth = await personalOAuth("member", "held-connection"), context = await delegated(oauth), id = context.authority!.proof.kind === "delegated" ? context.authority!.proof.connectionId : "";
    await env.DB.prepare("UPDATE mcp_connections SET status = 'revoked' WHERE id = ?").bind(id).run();
    await expect(authorizedBatch(env.DB, context, "inventory_create", [env.DB.prepare("UPDATE members SET display_name = 'must-not-commit' WHERE id = ?").bind(context.actorId)])).rejects.toMatchObject({ code: "forbidden" });
    expect(await env.DB.prepare("SELECT display_name FROM members WHERE id = ?").bind(context.actorId).first()).toMatchObject({ display_name: "held-connection" });
    expect((await realFetch(mcpRequest(oauth.tokens.access_token))).status).toBe(401);
    const refresh = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource }); expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
  });
  it("D1 revocation is immediate even when provider KV cleanup fails; healthy unrelated grants stay valid", async () => {
    const first = await personalOAuth("viewer", "revoke-viewer"), second = await personalOAuth("viewer", "other-viewer");
    const list = await data<{ connections: { id: string }[] }>(await realFetch(browserRequest(first.browser, "/api/v1/auth/connections")));
    const failingKV = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "delete") return () => Promise.reject(new Error("KV cleanup unavailable")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
    const revoke = await overriddenFetch({ OAUTH_KV: failingKV })(browserRequest(first.browser, `/api/v1/auth/connections/${list.connections[0]!.id}/revoke`, {})); expect(revoke.status).toBe(200);
    expect((await realFetch(mcpRequest(first.tokens.access_token))).status).toBe(401);
    expect((await realFetch(mcpRequest(second.tokens.access_token))).status).toBe(200);
    expect(await env.DB.prepare("SELECT cleanup_pending FROM mcp_connections WHERE id = ?").bind(list.connections[0]!.id).first()).toMatchObject({ cleanup_pending: 1 });
  });
  it("uses self-or-current-owner-and-approved-owner permission for another person's connections", async () => {
    const owner = await personalOAuth("owner", "local-owner"), member = await personalOAuth("member", "managed-member"), ownerContext = await delegated(owner), memberContext = await delegated(member);
    const service = new ConnectionAccessService(env.DB), memberList = await service.listConnections(ownerContext, { memberId: memberContext.actorId }); expect(memberList.connections).toHaveLength(1);
    await expect(service.listConnections(memberContext, { memberId: ownerContext.actorId })).rejects.toMatchObject({ code: "forbidden" });
    const oldMemberCeiling = await personalOAuth("member", "promoted-member"), limited = await delegated(oldMemberCeiling);
    await env.DB.prepare("UPDATE members SET role = 'owner' WHERE id = 'promoted-member'").run();
    await expect(service.listConnections(limited, { memberId: memberContext.actorId })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("records each accepted access revoke once and conflicts safely on operation-ID reuse", async () => {
    const actor = await personalOAuth("owner"), target = await personalOAuth("viewer", "audit-target"), context = await delegated(actor), service = new ConnectionAccessService(env.DB);
    const targetId = (await service.listConnections(context, { memberId: target.browser.memberId })).connections[0]!.id;
    await service.revokeConnection(context, targetId); await service.revokeConnection(context, targetId);
    const audit = await env.DB.prepare("SELECT actor_id, source, mcp_client_id, mcp_tool, changes_json FROM audit_events WHERE operation_id = ?").bind(context.operationId).all();
    expect(audit.results).toEqual([{ actor_id: context.actorId, source: "mcp", mcp_client_id: actor.client.client_id, mcp_tool: "connections_revoke", changes_json: "[]" }]);
    await expect(service.revokeConnection(context, "b".repeat(32))).rejects.toMatchObject({ code: "conflict" });
    const another = await personalOAuth("viewer", "audit-session-target"), session = new SessionAccessService(env.DB);
    const targetSessionId = another.browser.sessionId;
    const sessionContext = { ...context, operationId: crypto.randomUUID(), mcpTool: "sessions_revoke" };
    await session.revokeSession(sessionContext, targetSessionId); await session.revokeSession(sessionContext, targetSessionId);
    expect((await env.DB.prepare("SELECT id FROM audit_events WHERE operation_id = ?").bind(sessionContext.operationId).all()).results).toHaveLength(1);
    await expect(session.revokeSession(context, targetSessionId)).rejects.toMatchObject({ code: "conflict" });
  });
  it("revokes all old connection generations on credential replacement and all connections on deactivation", async () => {
    const oauth = await personalOAuth("member", "credential-member"), context = await delegated(oauth);
    await env.DB.batch([env.DB.prepare("UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = ?").bind(context.actorId), ...revokeMemberGrants(env.DB, context.actorId, "credentials")]);
    expect((await realFetch(mcpRequest(oauth.tokens.access_token))).status).toBe(401);
    const newer = await personalOAuth("member", context.actorId);
    await env.DB.batch([env.DB.prepare("UPDATE members SET archived_at = ? WHERE id = ?").bind(new Date().toISOString(), context.actorId), ...revokeMemberGrants(env.DB, context.actorId, "deactivated")]);
    await env.DB.prepare("UPDATE members SET archived_at = NULL WHERE id = ?").bind(context.actorId).run();
    expect((await realFetch(mcpRequest(newer.tokens.access_token))).status).toBe(401);
  });
  it("a failed new D1 activation preserves the old real provider grant", async () => {
    const old = await personalOAuth("member", "replace-member"), started = await startOAuth(old.browser, { client: old.client });
    const fetch = overriddenFetch({ DB: failDatabase(sql => sql.includes("UPDATE mcp_connections SET status = 'active'")) });
    const response = await fetch(browserRequest(started.browser, `/api/v1/auth/consent/${started.id}/approve`, {})); expect(response.status).toBe(503);
    expect((await realFetch(mcpRequest(old.tokens.access_token))).status).toBe(200);
    const rows = await env.DB.prepare("SELECT status, provider_grant_id FROM mcp_connections WHERE client_id = ? ORDER BY created_at").bind(old.client.client_id).all();
    expect(rows.results.map(row => row.status)).toEqual(["active", "failed"]);
    expect(rows.results[1]!.provider_grant_id).toBeNull();
  });
  it("successful replacement ends old D1 authority before the new authorization code is used", async () => {
    const old = await personalOAuth("member", "replace-success"), started = await startOAuth(old.browser, { client: old.client }), approved = await approveOAuth(started);
    expect((await realFetch(mcpRequest(old.tokens.access_token))).status).toBe(401);
    const tokens = await exchangeOAuth(started, approved.code); expect((await realFetch(mcpRequest(tokens.access_token))).status).toBe(200);
  });
  it("binds only unset or identical provider grant IDs; mismatched grant/client/resource/user never attach", async () => {
    const oauth = await personalOAuth("member", "binding-member"), context = await delegated(oauth), id = context.authority!.proof.kind === "delegated" ? context.authority!.proof.connectionId : "";
    const row = await env.DB.prepare("SELECT provider_grant_id FROM mcp_connections WHERE id = ?").bind(id).first<{ provider_grant_id: string }>();
    const options = { env, grantType: GrantType.AUTHORIZATION_CODE, clientId: oauth.client.client_id, subjectClientId: oauth.client.client_id, userId: context.actorId, grantId: row!.provider_grant_id, scope: ["home:access"], requestedScope: ["home:access"], resource, props: { connectionId: id } };
    await bindProviderGrant(options); await bindProviderGrant(options);
    await expect(bindProviderGrant({ ...options, grantId: "different-provider-grant" })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(bindProviderGrant({ ...options, clientId: "other" })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(bindProviderGrant({ ...options, resource: "https://elsewhere.test/mcp" })).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(bindProviderGrant({ ...options, userId: "someone-else" })).rejects.toMatchObject({ code: "invalid_grant" });
  });
  it("returns retryable outages without revoking a healthy provider grant", async () => {
    const oauth = await personalOAuth("member", "outage-member"), fetch = overriddenFetch({ DB: failDatabase(sql => sql.includes("mcp_connections")) });
    const response = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource }, fetch);
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await fetch(mcpRequest(oauth.tokens.access_token))).status).toBe(503);
    const healthy = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource }); expect(healthy.status).toBe(200);
    const helpers = getOAuthApi(oauthOptions(env, { fetch: () => new Response() }), env);
    expect((await helpers.listUserGrants(oauth.browser.memberId)).items).toHaveLength(1);
  });
  it("exposes only safe public session IDs and rejects a logout intended for an earlier same-person grant", async () => {
    const older = await browserProof(), newer = await browserProof();
    const status = await data<{ session: { sessionId: string } }>(await realFetch(browserRequest(newer, "/api/v1/auth/status")));
    expect(status.session.sessionId).toBe(newer.sessionId);
    const logout = await realFetch(browserRequest(newer, "/api/v1/auth/logout", { expectedSessionId: older.sessionId })); expect(logout.status).toBe(409); expect(logout.headers.has("set-cookie")).toBe(false);
    expect(await env.DB.prepare("SELECT public_id FROM auth_sessions WHERE public_id = ?").bind(newer.sessionId).first()).not.toBeNull();
    expect((await realFetch(browserRequest(newer, "/api/v1/auth/logout", {}))).status).toBe(200);
    expect(await env.DB.prepare("SELECT public_id FROM auth_sessions WHERE public_id = ?").bind(older.sessionId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT token_hash FROM auth_sessions WHERE token_hash = ?").bind(await digest(newer.cookie.split("=")[1]!)).first()).toBeNull();
  });
});

it("an owner's demotion immediately before access-mutation acceptance rolls back target revoke and audit", async () => {
  const owner = await personalOAuth("owner"), backup = await browserProof("owner", "backup-owner"), target = await personalOAuth("viewer", "late-owner-target"), context = await delegated(owner);
  const service = new ConnectionAccessService(env.DB), id = (await service.listConnections(context, { memberId: target.browser.memberId })).connections[0]!.id;
  let held = true;
  const database = new Proxy(env.DB, { get(db, property) { if (property === "batch") return async (statements: D1PreparedStatement[]) => {
    if (held) { held = false; await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE id = 'local-owner'").run(); }
    return db.batch(statements);
  }; const value = Reflect.get(db, property); return typeof value === "function" ? value.bind(db) : value; } });
  await expect(new ConnectionAccessService(database).revokeConnection(context, id)).rejects.toMatchObject({ code: "forbidden" });
  expect(await env.DB.prepare("SELECT status FROM mcp_connections WHERE id = ?").bind(id).first()).toMatchObject({ status: "active" });
  expect((await env.DB.prepare("SELECT id FROM audit_events WHERE operation_id = ?").bind(context.operationId).all()).results).toHaveLength(0);
  expect(backup.memberId).toBe("backup-owner");
});
it("established refresh KV persistence failure preserves continuing D1 and the old real grant", async () => {
  const oauth = await personalOAuth("member", "refresh-kv-outage");
  const failingKV = new Proxy(env.OAUTH_KV, { get(kv, property) { if (property === "put") return () => Promise.reject(new Error("KV persistence unavailable")); const value = Reflect.get(kv, property); return typeof value === "function" ? value.bind(kv) : value; } });
  const response = await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource }, overriddenFetch({ OAUTH_KV: failingKV }));
  expect(response.status).toBe(503);
  expect(await env.DB.prepare("SELECT status, established_at IS NOT NULL AS established FROM mcp_connections WHERE client_id = ?").bind(oauth.client.client_id).first()).toMatchObject({ status: "active", established: 1 });
  expect((await realFetch(mcpRequest(oauth.tokens.access_token))).status).toBe(200);
  expect((await tokenRequest({ grant_type: "refresh_token", client_id: oauth.client.client_id, refresh_token: oauth.tokens.refresh_token, resource })).status).toBe(200);
});
