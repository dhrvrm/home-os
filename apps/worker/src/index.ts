import { Hono } from "hono";
import type { Env } from "./env";
import { createActivityRoutes } from "./http/activity-routes";
import { failure, success } from "./http/envelope";
import { createInventoryRoutes } from "./http/inventory-routes";
import { HomeOSError, ValidationError } from "./platform/errors";
import { createSyncRoutes } from "./sync/routes";
import { createMcpRoutes } from "./mcp/routes";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "same-origin");
  context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.get("/healthz", (context) => success(context, { status: "ok" as const }));

app.get("/readyz", async (context) => {
  try {
    await context.env.DB.prepare("SELECT 1 AS ready").first();
    return success(context, { status: "ready" as const });
  } catch {
    return failure(context, { code: "not_ready", message: "Home OS storage is unavailable." }, 503);
  }
});

app.route("/api/v1", createActivityRoutes());
app.route("/api/v1", createSyncRoutes());
app.route("/api/v1", createInventoryRoutes());
app.route("/", createMcpRoutes());

app.onError((error, context) => {
  if (error instanceof ValidationError) {
    return failure(context, { code: error.code, message: error.message, field: error.field }, 400);
  }
  if (error instanceof HomeOSError) {
    return failure(context, { code: error.code, message: error.message }, error.status as 404 | 409);
  }
  console.error("Unhandled Home OS request error", error);
  return failure(context, { code: "internal_error", message: "Home OS could not complete the request." }, 500);
});

app.all("*", (context) => {
  if (context.req.path.startsWith("/api/") || context.req.path.startsWith("/mcp")) {
    return failure(context, { code: "not_found", message: "Route not found." }, 404);
  }
  return context.env.ASSETS.fetch(context.req.raw);
});

export { app };
export default app;
