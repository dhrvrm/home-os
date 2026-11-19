import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { mcpRequest, overriddenFetch, personalOAuth, realFetch, resetOAuthFixtures } from "./oauth-fixtures";

async function rpc(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find(line => line.startsWith("data: "))!.slice(6)
    : text);
}

beforeEach(async () => {
  await resetOAuthFixtures();
  await env.DB.prepare("DELETE FROM inventory_items").run();
});

it.each(["resource", "tool"] as const)("checks continuing authority before disclosing a completed %s read", async transport => {
  const oauth = await personalOAuth("owner", "catalog-reader");
  const name = "Inventory from an ended grant";
  await rpc(await realFetch(mcpRequest(oauth.tokens.access_token, "tools/call", {
    name: "inventory_create", arguments: { operationId: "catalog-item", name },
  })));
  let ended = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(Reflect.apply(target.bind, target, values));
      if (property === "all") return async () => {
        const result = await target.all();
        await env.DB.prepare("UPDATE mcp_connections SET status = 'revoked' WHERE member_id = ?").bind(oauth.browser.memberId).run();
        ended = true;
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return sql.includes("COUNT(CASE WHEN event_type") ? wrap(statement) : statement;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const request = transport === "resource"
    ? mcpRequest(oauth.tokens.access_token, "resources/read", { uri: "home-os://inventory/catalog" })
    : mcpRequest(oauth.tokens.access_token, "tools/call", { name: "inventory_list", arguments: {} });
  const body = await rpc(await overriddenFetch({ DB: database })(request));
  expect(ended).toBe(true);
  expect(JSON.stringify(body)).not.toContain(name);
  if (transport === "resource") expect(body).toHaveProperty("error");
  else expect(body.result).toMatchObject({ isError: true, structuredContent: { status: "refused" } });
});
