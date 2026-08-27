import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth/auth";
import { HOME_OS_ORGANIZATION_CLAIM } from "../src/auth/constants";
import type { Env } from "../src/env";
import { apiWithAuth, createAuthenticatedHome, type AuthenticatedHome } from "./auth-helpers";

const testEnv = env as unknown as Env;
let authenticatedHome: AuthenticatedHome;
let accessToken = "";

async function callMcp(method: string, params?: unknown, id = 1, token = accessToken): Promise<Response> {
  return exports.default.fetch(new Request("https://home-os.test/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  }));
}

async function jsonRpc<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return JSON.parse(text) as T;
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error("MCP response did not contain an SSE data event.");
  return JSON.parse(data) as T;
}

describe("OAuth-protected read-only MCP server", () => {
  beforeAll(async () => {
    authenticatedHome = await createAuthenticatedHome("mcp-api");
    accessToken = await mintMcpToken(authenticatedHome);
  });

  it("publishes protected-resource and authorization-server discovery", async () => {
    const protectedResource = await exports.default.fetch(
      new Request("https://home-os.test/.well-known/oauth-protected-resource/mcp"),
    );
    expect(protectedResource.status).toBe(200);
    await expect(protectedResource.json()).resolves.toMatchObject({
      resource: "https://home-os.test/mcp",
      authorization_servers: ["https://home-os.test/api/auth"],
      scopes_supported: expect.arrayContaining(["inventory:read", "activity:read"]),
    });

    const authorizationServer = await exports.default.fetch(
      new Request("https://home-os.test/.well-known/oauth-authorization-server/api/auth"),
    );
    expect(authorizationServer.status).toBe(200);
    await expect(authorizationServer.json()).resolves.toMatchObject({
      issuer: "https://home-os.test/api/auth",
      authorization_endpoint: "https://home-os.test/api/auth/oauth2/authorize",
      token_endpoint: "https://home-os.test/api/auth/oauth2/token",
      registration_endpoint: "https://home-os.test/api/auth/oauth2/register",
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("allows unauthenticated dynamic client registration for MCP clients", async () => {
    const response = await exports.default.fetch(new Request("https://home-os.test/api/auth/oauth2/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Home OS MCP test client",
        redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid profile email offline_access inventory:read activity:read",
      }),
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client_id: expect.any(String),
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    });
  });

  it("returns an OAuth resource challenge without a token", async () => {
    const response = await exports.default.fetch(new Request("https://home-os.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://home-os.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain("inventory:read");
  });

  it("initializes and exposes only read-only inventory and audit tools", async () => {
    const initialized = await callMcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "home-os-test", version: "1.0.0" },
    });
    expect(initialized.status).toBe(200);
    await expect(jsonRpc(initialized)).resolves.toMatchObject({ result: { serverInfo: { name: "home-os" } } });

    const listed = await callMcp("tools/list");
    expect(listed.status).toBe(200);
    const body = await jsonRpc<{ result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } }>(listed);
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "activity_list",
      "inventory_attention",
      "inventory_get",
      "inventory_list",
    ]);
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it("queries only the token-bound organization inventory", async () => {
    const create = await apiWithAuth("/api/v1/items", authenticatedHome.cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Operation-ID": "mcp-seed-item" },
      body: JSON.stringify({ name: "Masoor dal", alternativeNames: ["मसूर दाल"], categories: ["Food", "Staples"], levelPercent: 20 }),
    });
    expect(create.status).toBe(201);

    const response = await callMcp("tools/call", {
      name: "inventory_list",
      arguments: { query: "मसूर" },
    });
    expect(response.status).toBe(200);
    await expect(jsonRpc(response)).resolves.toMatchObject({
      result: {
        structuredContent: {
          count: 1,
          items: [{ name: "Masoor dal", alternativeNames: ["मसूर दाल"], categories: ["Food", "Staples"] }],
        },
      },
    });
  });

  it("rechecks membership and rejects access immediately after revocation", async () => {
    const revokedHome = await createAuthenticatedHome("revoked-mcp-api");
    const revokedToken = await mintMcpToken(revokedHome);
    await testEnv.DB.prepare("DELETE FROM member WHERE id = ?").bind(revokedHome.membershipId).run();

    const response = await callMcp("tools/list", undefined, 91, revokedToken);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Organization access has been revoked." },
    });
  });
});

async function mintMcpToken(home: AuthenticatedHome): Promise<string> {
  const auth = createAuth(testEnv);
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        sub: home.userId,
        sid: home.sessionId,
        aud: "https://home-os.test/mcp",
        scope: "inventory:read activity:read",
        [HOME_OS_ORGANIZATION_CLAIM]: home.organizationId,
      },
    },
  });
  return token;
}
