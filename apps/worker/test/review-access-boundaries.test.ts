import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  browserProof, browserRequest, mcpRequest, personalOAuth, realFetch,
  resetOAuthFixtures, resource, tokenRequest,
} from "./oauth-fixtures";

beforeEach(resetOAuthFixtures);

describe("access across predecessor writes", () => {
  it("never restores a person's active or pending connections after predecessor deactivation and reactivation", async () => {
    const member = await personalOAuth("member", "predecessor-member");
    const other = await personalOAuth("viewer", "unrelated-viewer");
    const row = await env.DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ?")
      .bind(member.client.client_id).first<{ id: string }>();
    const pendingId = crypto.randomUUID().replaceAll("-", "");
    const endedId = crypto.randomUUID().replaceAll("-", "");
    const oldEnd = "2020-01-01T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO mcp_connections
        (id, member_id, household_id, credential_version, client_id, client_name, resource, approved_role, status, created_at, exchange_until)
        SELECT ?, member_id, household_id, credential_version, client_id, client_name, resource, approved_role, 'pending', created_at, exchange_until
        FROM mcp_connections WHERE id = ?`).bind(pendingId, row!.id),
      env.DB.prepare(`INSERT INTO mcp_connections
        (id, member_id, household_id, credential_version, client_id, client_name, resource, approved_role, status, created_at, exchange_until, ended_at)
        SELECT ?, member_id, household_id, credential_version, client_id, client_name, resource, approved_role, 'revoked', created_at, exchange_until, ?
        FROM mcp_connections WHERE id = ?`).bind(endedId, oldEnd, row!.id),
    ]);
    const version = await env.DB.prepare("SELECT credential_version FROM auth_accounts WHERE member_id = ?")
      .bind(member.browser.memberId).first();
    // The predecessor only archived the member and deleted their browser sessions.
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET archived_at = ?, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), new Date().toISOString(), member.browser.memberId),
      env.DB.prepare("DELETE FROM auth_sessions WHERE member_id = ?").bind(member.browser.memberId),
    ]);
    expect((await realFetch(mcpRequest(member.tokens.access_token))).status).toBe(401);
    await env.DB.prepare("UPDATE members SET archived_at = NULL WHERE id = ?").bind(member.browser.memberId).run();

    expect((await realFetch(mcpRequest(member.tokens.access_token))).status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: "refresh_token", client_id: member.client.client_id,
      refresh_token: member.tokens.refresh_token, resource,
    });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    const connections = await env.DB.prepare("SELECT id, status, ended_at, cleanup_pending FROM mcp_connections WHERE member_id = ? ORDER BY id")
      .bind(member.browser.memberId).all<{ id: string; status: string; ended_at: string | null; cleanup_pending: number }>();
    for (const id of [row!.id, pendingId]) {
      const connection = connections.results.find(connection => connection.id === id)!;
      expect(connection).toMatchObject({ status: "revoked", cleanup_pending: 1 });
      expect(Number.isFinite(Date.parse(connection.ended_at!))).toBe(true);
    }
    expect(connections.results.find(connection => connection.id === endedId))
      .toMatchObject({ status: "revoked", ended_at: oldEnd, cleanup_pending: 0 });
    expect(await env.DB.prepare("SELECT credential_version FROM auth_accounts WHERE member_id = ?")
      .bind(member.browser.memberId).first()).toEqual(version);
    expect((await realFetch(mcpRequest(other.tokens.access_token))).status).toBe(200);
  });

  it("keeps continuing connections during an active-member profile edit", async () => {
    const member = await personalOAuth("member", "profile-member");
    await env.DB.prepare("UPDATE members SET display_name = ?, archived_at = NULL WHERE id = ?")
      .bind("Updated member", member.browser.memberId).run();
    expect((await realFetch(mcpRequest(member.tokens.access_token))).status).toBe(200);
  });

  it("backfills an archived member's previously unended connection before installing the transition guard", async () => {
    const member = await personalOAuth("member", "archived-before-migration");
    const migrations = (env as typeof env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const migration = migrations.find(migration => migration.name === "0011_deactivation_grants.sql");
    expect(migration).toBeDefined();
    await env.DB.prepare("DROP TRIGGER IF EXISTS revoke_deactivated_member_connections").run();
    await env.DB.prepare("UPDATE members SET archived_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), member.browser.memberId).run();
    expect(await env.DB.prepare("SELECT status FROM mcp_connections WHERE client_id = ?")
      .bind(member.client.client_id).first()).toMatchObject({ status: "active" });

    await env.DB.batch(migration!.queries.map(query => env.DB.prepare(query)));
    expect(await env.DB.prepare("SELECT status, cleanup_pending, ended_at IS NOT NULL AS ended FROM mcp_connections WHERE client_id = ?")
      .bind(member.client.client_id).first()).toMatchObject({ status: "revoked", cleanup_pending: 1, ended: 1 });
    await env.DB.prepare("UPDATE members SET archived_at = NULL WHERE id = ?").bind(member.browser.memberId).run();
    expect((await realFetch(mcpRequest(member.tokens.access_token))).status).toBe(401);
  });
});

describe("Viewer HTTP read-method parity", () => {
  it.each(["/items", "/members", "/expenses", "/recipes", "/meals", "/contacts", "/notifications/preferences"])(
    "permits GET and bodyless HEAD for %s while refusing writes", async route => {
      const viewer = await browserProof("viewer", "head-viewer");
      const path = `/api/v1${route}${route === "/meals" ? "?from=2026-11-19&to=2026-11-26" : ""}`;
      const get = await realFetch(browserRequest(viewer, path));
      expect(get.status).toBe(200);
      const head = await realFetch(new Request(browserRequest(viewer, path), { method: "HEAD" }));
      expect(head.status).toBe(get.status);
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(await head.text()).toBe("");
      if (route !== "/notifications/preferences") {
        expect((await realFetch(browserRequest(viewer, `/api/v1${route}`, {}))).status).toBe(403);
      }
    },
  );
});
