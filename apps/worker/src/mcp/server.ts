import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env";
import { D1InventoryRepository } from "../inventory/d1-repository";
import { InventoryService } from "../inventory/service";
import { listAuditEvents } from "../platform/audit";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createHomeOSMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "home-os", version: "0.1.0" });
  const inventory = new InventoryService(new D1InventoryRepository(env.DB));
  const householdId = env.HOMEOS_DEFAULT_HOUSEHOLD_ID;

  server.registerTool(
    "inventory_list",
    {
      title: "List household inventory",
      description: "Search and filter active or archived household inventory, including alternative names, categories, stock and consumption forecasts.",
      inputSchema: z.object({
        query: z.string().max(120).optional(),
        category: z.string().max(60).optional(),
        stockLevel: z.enum(["full", "okay", "low", "out"]).optional(),
        archived: z.enum(["exclude", "only", "include"]).default("exclude"),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ query, category, stockLevel, archived }) => {
      const items = await inventory.listItems(householdId, { query, category, stockLevel, archived });
      return result({ items, count: items.length });
    },
  );

  server.registerTool(
    "inventory_get",
    {
      title: "Get inventory item",
      description: "Get one inventory item and its immutable stock-event history.",
      inputSchema: z.object({ itemId: z.string().min(1).max(128) }),
      annotations: readOnlyAnnotations,
    },
    async ({ itemId }) => {
      const [item, events] = await Promise.all([
        inventory.getItem(householdId, itemId),
        inventory.listEvents(householdId, itemId),
      ]);
      return result({ item, events });
    },
  );

  server.registerTool(
    "inventory_attention",
    {
      title: "List inventory needing attention",
      description: "List low and out-of-stock household items for shopping or replenishment planning.",
      inputSchema: z.object({ category: z.string().max(60).optional() }),
      annotations: readOnlyAnnotations,
    },
    async ({ category }) => {
      const [out, low] = await Promise.all([
        inventory.listItems(householdId, { category, stockLevel: "out", archived: "exclude" }),
        inventory.listItems(householdId, { category, stockLevel: "low", archived: "exclude" }),
      ]);
      const items = [...out, ...low];
      return result({ items, count: items.length });
    },
  );

  server.registerTool(
    "activity_list",
    {
      title: "List Home OS activity",
      description: "Read the append-only audit trail, optionally filtered to an entity, item, or actor.",
      inputSchema: z.object({
        after: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        entityType: z.string().max(80).optional(),
        entityId: z.string().max(128).optional(),
        actorId: z.string().max(128).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (filter) => result(await listAuditEvents(env.DB, householdId, filter)),
  );

  server.registerResource(
    "inventory-catalog",
    "home-os://inventory/catalog",
    {
      title: "Home inventory catalog",
      description: "Current active household inventory as JSON.",
      mimeType: "application/json",
    },
    async (uri) => {
      const items = await inventory.listItems(householdId, { archived: "exclude" });
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ items, count: items.length }),
        }],
      };
    },
  );

  return server;
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}
