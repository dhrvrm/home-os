import { Hono } from "hono";
import type { AppContext } from "../auth/context";
import { listAuditEvents } from "../platform/audit";
import { ValidationError } from "../platform/errors";
import { success } from "./envelope";

export function createActivityRoutes(): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  routes.get("/activity", async (context) => {
    const result = await listAuditEvents(
      context.env.DB,
      context.get("auth").household!.id,
      activityFilter(context.req.query()),
    );
    return success(context, result);
  });

  routes.get("/items/:id/activity", async (context) => {
    const result = await listAuditEvents(context.env.DB, context.get("auth").household!.id, {
      ...activityFilter(context.req.query()),
      entityType: "inventory_item",
      entityId: context.req.param("id"),
    });
    return success(context, result);
  });

  return routes;
}

function activityFilter(query: Record<string, string>) {
  const requestedLimit = query.limit ? Number(query.limit) : undefined;
  if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)) {
    throw new ValidationError("limit", "must be a positive integer");
  }
  return {
    after: query.after,
    limit: requestedLimit,
    entityType: query.entityType,
    entityId: query.entityId,
    actorId: query.actorId,
  };
}
