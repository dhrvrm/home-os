import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { D1InventoryRepository } from "../inventory/d1-repository";
import { InventoryService } from "../inventory/service";
import { ValidationError } from "../platform/errors";
import { commandContext } from "./request-context";
import { success } from "./envelope";

const trackingMode = z.enum(["simple", "exact"]);
const stockLevel = z.enum(["full", "okay", "low", "out"]);
const createItemInput = z.object({
  name: z.string(),
  alternativeNames: z.array(z.string()).optional(),
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  trackingMode: trackingMode.optional(),
  quantity: z.number().optional(),
  stockLevel: stockLevel.optional(),
  levelPercent: z.number().optional(),
  minQuantity: z.number().optional(),
});
const updateItemInput = z.object({
  name: z.string().optional(),
  alternativeNames: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  minQuantity: z.number().optional(),
});
const stockEventInput = z.object({
  type: z.enum(["consume", "restock", "mark_level"]),
  quantity: z.number().optional(),
  stockLevel: stockLevel.optional(),
  levelPercent: z.number().optional(),
  note: z.string().optional(),
});

export function createInventoryRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/items", async (context) => {
    const archived = context.req.query("archived") || "exclude";
    if (archived !== "exclude" && archived !== "only" && archived !== "include") {
      throw new ValidationError("archived", "must be only or include");
    }
    const requestedStock = context.req.query("stockLevel");
    if (requestedStock && !stockLevel.safeParse(requestedStock).success) {
      throw new ValidationError("stockLevel", "must be full, okay, low, or out");
    }
    const service = inventoryService(context.env.DB);
    const items = await service.listItems(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID, {
      query: context.req.query("q"),
      category: context.req.query("category"),
      stockLevel: requestedStock as z.infer<typeof stockLevel> | undefined,
      archived,
    });
    return success(context, { items });
  });

  routes.post("/items", async (context) => {
    const input = await parsedJSON(context, createItemInput);
    const item = await inventoryService(context.env.DB).createItem(commandContext(context), input);
    return success(context, { item }, 201);
  });

  routes.get("/items/:id", async (context) => {
    const item = await inventoryService(context.env.DB).getItem(
      context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
      context.req.param("id"),
    );
    return success(context, { item });
  });

  routes.patch("/items/:id", async (context) => {
    const input = await parsedJSON(context, updateItemInput);
    const item = await inventoryService(context.env.DB).updateItem(
      commandContext(context),
      context.req.param("id"),
      input,
    );
    return success(context, { item });
  });

  routes.delete("/items/:id", async (context) => {
    const item = await inventoryService(context.env.DB).archiveItem(commandContext(context), context.req.param("id"));
    return success(context, { item });
  });

  routes.post("/items/:id/restore", async (context) => {
    const item = await inventoryService(context.env.DB).restoreItem(commandContext(context), context.req.param("id"));
    return success(context, { item });
  });

  routes.get("/items/:id/events", async (context) => {
    const events = await inventoryService(context.env.DB).listEvents(
      context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
      context.req.param("id"),
      context.req.query("since"),
    );
    return success(context, { events });
  });

  routes.post("/items/:id/events", async (context) => {
    const input = await parsedJSON(context, stockEventInput);
    const item = await inventoryService(context.env.DB).applyStockEvent(
      commandContext(context),
      context.req.param("id"),
      input,
    );
    return success(context, { item }, 201);
  });

  routes.get("/export", async (context) => {
    const service = inventoryService(context.env.DB);
    const items = await service.listItems(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID, { archived: "include" });
    const exported = await Promise.all(
      items.map(async (item) => ({
        item,
        events: await service.listEvents(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID, item.id),
      })),
    );
    return success(context, { version: 1 as const, exportedAt: new Date().toISOString(), items: exported });
  });

  return routes;
}

function inventoryService(database: D1Database): InventoryService {
  return new InventoryService(new D1InventoryRepository(database));
}

async function parsedJSON<T extends z.ZodType>(
  context: Parameters<typeof commandContext>[0],
  schema: T,
): Promise<z.infer<T>> {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (contentLength > 64 * 1024) throw new ValidationError("body", "must be 64 KB or smaller");
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ValidationError("body", "must contain valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.path.join(".") || "body", issue?.message ?? "is invalid");
  }
  return parsed.data;
}
