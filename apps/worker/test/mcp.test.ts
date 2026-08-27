import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { apiWithAuth, createAuthenticatedHome, type AuthenticatedHome } from "./auth-helpers";

const mcpHeaders = {
  Accept: "application/json, text/event-stream",
  Authorization: "Bearer test-mcp-token",
  "Content-Type": "application/json",
};
let authenticatedHome: AuthenticatedHome;

async function callMcp(method: string, params?: unknown, id = 1): Promise<Response> {
  return exports.default.fetch(new Request("https://home-os.test/mcp", {
    method: "POST",
    headers: mcpHeaders,
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

describe("read-only MCP server", () => {
  beforeAll(async () => {
    authenticatedHome = await createAuthenticatedHome("mcp-api");
  });

  it("requires the configured bearer token", async () => {
    const response = await exports.default.fetch(new Request("https://home-os.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="home-os-mcp"');
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

  it("queries D1 inventory through MCP", async () => {
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
});
