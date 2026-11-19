import { exports } from "cloudflare:workers";
import { personalOAuth } from "./oauth-fixtures";
import { authenticatedFetch } from "./authenticated-worker";
import { describe, expect, it } from "vitest";

const mcpHeaders = {
  Accept: "application/json, text/event-stream",
  Authorization: "Bearer test-mcp-token",
  "Content-Type": "application/json",
};

async function callMcp(method: string, params?: unknown, id = 1): Promise<Response> {
  const oauth = await personalOAuth();
  return exports.default.fetch(new Request("https://home-os.test/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, Authorization: `Bearer ${oauth.tokens.access_token}` },
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

describe("personally authorized MCP server", () => {
  it("requires personal OAuth authorization", async () => {
    const response = await exports.default.fetch(new Request("https://home-os.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('resource_metadata="https://home-os.test/.well-known/oauth-protected-resource/mcp"');
  });

  it("initializes and exposes permitted inventory, recurring-rule and audit tools", async () => {
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
      "expenses_archive", "expenses_create", "expenses_get", "expenses_list", "expenses_restore", "expenses_update",
      "inventory_archive", "inventory_attention", "inventory_create", "inventory_events", "inventory_export", "inventory_get", "inventory_list", "inventory_restore", "inventory_stock", "inventory_update",
      "home_context", "recipes_list", "recipes_get", "recipes_create", "recipes_update", "recipes_archive", "recipes_restore",
      "meals_list", "meals_get", "meals_create", "meals_update", "meals_cancel", "meal_attendance_set",
      "contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_archive", "contacts_restore",
      "notifications_list", "notifications_mark_read", "notification_preferences_get", "notification_preferences_set", "notification_device_setup",
      "members_list", "members_update", "member_access_setup", "member_password_reset", "account_password_change",
      "connections_list", "connections_revoke", "sessions_list", "sessions_revoke",
    ].sort());
    expect(body.result.tools.filter(tool => ["activity_list", "inventory_list", "inventory_attention", "inventory_get", "inventory_events", "inventory_export", "expenses_get", "expenses_list", "home_context", "recipes_list", "recipes_get", "meals_list", "meals_get", "contacts_list", "contacts_get", "notifications_list", "notification_preferences_get", "members_list", "connections_list", "sessions_list"].includes(tool.name)).every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(body.result.tools.filter(tool => tool.name.endsWith("_create")).every(tool => !tool.annotations.readOnlyHint)).toBe(true);
  });

  it("queries D1 inventory through MCP", async () => {
    const create = await authenticatedFetch(new Request("https://home-os.test/api/v1/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Operation-ID": "mcp-seed-item" },
      body: JSON.stringify({ name: "Masoor dal", alternativeNames: ["मसूर दाल"], categories: ["Food", "Staples"], levelPercent: 20 }),
    }));
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

it("connects and reads the existing MCP surface using the official 2.4 client transport", async () => {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const oauth = await personalOAuth("viewer", "official-sdk-viewer");
  const transport = new StreamableHTTPClientTransport(new URL("https://home-os.test/mcp"), {
    authProvider: { token: async () => oauth.tokens.access_token },
    fetch: async (input, init) => exports.default.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "official-client-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      "activity_list", "expenses_get", "expenses_list", "inventory_attention", "inventory_events", "inventory_export", "inventory_get", "inventory_list",
      "home_context", "recipes_list", "recipes_get", "meals_list", "meals_get", "contacts_list", "contacts_get",
      "notifications_list", "notifications_mark_read", "notification_preferences_get", "notification_preferences_set", "notification_device_setup",
      "members_list", "connections_list", "connections_revoke", "sessions_list", "sessions_revoke", "account_password_change",
    ].sort());
    expect(await client.callTool({ name: "inventory_list", arguments: {} })).toMatchObject({ structuredContent: { items: expect.any(Array) } });
    expect((await client.readResource({ uri: "home-os://inventory/catalog" })).contents).toHaveLength(1);
  } finally { await client.close(); }
});
