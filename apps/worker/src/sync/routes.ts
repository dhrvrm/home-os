import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { D1InventoryRepository } from "../inventory/d1-repository";
import { InventoryService } from "../inventory/service";
import { listAuditEvents } from "../platform/audit";
import type { CommandContext } from "../platform/context";
import { ConflictError, HomeOSError, ValidationError } from "../platform/errors";
import { success } from "../http/envelope";
import type { SyncConflictResult, SyncOperation, SyncResponse } from "./model";

const operationSchema = z.object({
  operationId: z.string().min(1).max(128),
  householdId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  kind: z.enum([
    "inventory.create",
    "inventory.update",
    "inventory.stock",
    "inventory.archive",
    "inventory.restore",
  ]),
  entityId: z.string().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(),
  clientTime: z.string().datetime(),
  payload: z.unknown(),
});
const syncRequestSchema = z.object({
  cursor: z.number().int().nonnegative().default(0),
  operations: z.array(operationSchema).max(50),
});
const createPayload = z.object({
  name: z.string(),
  alternativeNames: z.array(z.string()).optional(),
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  trackingMode: z.enum(["simple", "exact"]).optional(),
  quantity: z.number().optional(),
  stockLevel: z.enum(["full", "okay", "low", "out"]).optional(),
  levelPercent: z.number().optional(),
  minQuantity: z.number().optional(),
});
const updatePayload = z.object({
  name: z.string().optional(),
  alternativeNames: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  minQuantity: z.number().optional(),
});
const stockPayload = z.object({
  id: z.string().optional(),
  type: z.enum(["consume", "restock", "mark_level"]),
  quantity: z.number().optional(),
  stockLevel: z.enum(["full", "okay", "low", "out"]).optional(),
  levelPercent: z.number().optional(),
  note: z.string().optional(),
});

export function createSyncRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post("/sync", async (context) => {
    const parsed = syncRequestSchema.safeParse(await readJSON(context));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(issue?.path.join(".") || "body", issue?.message ?? "is invalid");
    }
    const householdId = context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID;
    const service = new InventoryService(new D1InventoryRepository(context.env.DB));
    const results: SyncResponse["results"] = [];

    for (const operation of parsed.data.operations as SyncOperation[]) {
      if (operation.householdId !== householdId) {
        results.push({
          operationId: operation.operationId,
          status: "rejected",
          error: { code: "unauthorized", message: "This operation belongs to another household." },
        });
        continue;
      }
      try {
        await applyOperation(service, operation);
        results.push({ operationId: operation.operationId, status: "accepted" });
      } catch (error) {
        results.push(await operationError(service, operation, error));
      }
    }

    const items = await service.listItems(householdId, { archived: "include" });
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const events = (
      await Promise.all(items.map((item) => service.listEvents(householdId, item.id, ninetyDaysAgo)))
    ).flat();
    const audit = await listAuditEvents(context.env.DB, householdId, {
      after: parsed.data.cursor ? btoa(String(parsed.data.cursor)) : undefined,
      limit: 100,
    });
    const cursor = audit.events.at(-1)?.sequence ?? parsed.data.cursor;
    return success<SyncResponse>(context, { results, items, events, activity: audit.events, cursor });
  });

  return routes;
}

async function applyOperation(service: InventoryService, operation: SyncOperation): Promise<void> {
  const context: CommandContext = {
    householdId: operation.householdId,
    actorId: "local-owner",
    actorType: "member",
    source: "pwa",
    operationId: operation.operationId,
    expectedVersion: operation.expectedVersion || undefined,
    deviceId: operation.deviceId,
    clientTime: operation.clientTime,
  };
  if (operation.kind === "inventory.create") {
    await service.createItem(context, { ...parsePayload(createPayload, operation.payload), id: operation.entityId });
  } else if (operation.kind === "inventory.update") {
    await service.updateItem(context, operation.entityId, parsePayload(updatePayload, operation.payload));
  } else if (operation.kind === "inventory.stock") {
    await service.applyStockEvent(context, operation.entityId, parsePayload(stockPayload, operation.payload));
  } else if (operation.kind === "inventory.archive") {
    await service.archiveItem(context, operation.entityId);
  } else {
    await service.restoreItem(context, operation.entityId);
  }
}

async function operationError(
  service: InventoryService,
  operation: SyncOperation,
  error: unknown,
): Promise<SyncConflictResult> {
  if (error instanceof ConflictError) {
    return {
      operationId: operation.operationId,
      status: "conflict",
      error: { code: error.code, message: error.message },
      item: await service.getItem(operation.householdId, operation.entityId),
    };
  }
  if (error instanceof HomeOSError) {
    return {
      operationId: operation.operationId,
      status: "rejected",
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError ? { field: error.field } : {}),
      },
    };
  }
  throw error;
}

function parsePayload<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.path.join(".") || "payload", issue?.message ?? "is invalid");
  }
  return parsed.data;
}

async function readJSON(context: Context<{ Bindings: Env }>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ValidationError("body", "must contain valid JSON");
  }
}
