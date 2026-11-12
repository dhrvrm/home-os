import { env } from "cloudflare:workers";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../src/env";
import { protectHousehold } from "../src/auth/session";
import { digest } from "../src/auth/crypto";
import { failure } from "../src/http/envelope";
import {
  ConflictError,
  HomeOSError,
  ValidationError,
} from "../src/platform/errors";
import { createMealRoutes } from "../src/meals/routes";
import { createContactRoutes } from "../src/contacts/routes";
const app = new Hono<{ Bindings: Env }>();
app.use("/api/v1/*", protectHousehold);
app.route("/api/v1", createMealRoutes());
app.route("/api/v1", createContactRoutes());
app.onError((error, context) => {
  if (error instanceof ValidationError)
    return failure(
      context,
      { code: error.code, message: error.message, field: error.field },
      400,
    );
  if (error instanceof ConflictError)
    return failure(
      context,
      { code: error.code, message: error.message, details: error.details },
      409,
    );
  if (error instanceof HomeOSError)
    return failure(
      context,
      { code: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  console.error(error);
  return failure(context, { code: "internal_error", message: "failed" }, 500);
});
export async function cookingApi(
  path: string,
  method = "GET",
  body?: unknown,
  options: {
    member?: string;
    role?: string;
    operation?: string;
    version?: number;
    authenticated?: boolean;
    emptyBodyStream?: boolean;
  } = {},
) {
  const member = options.member ?? "local-owner";
  const token = await digest(`cooking-fixture:${member}`);
  if (options.authenticated !== false) {
    if (member !== "local-owner")
      await env.DB.prepare(
        "INSERT OR IGNORE INTO members (id,household_id,display_name,role,created_at,updated_at) VALUES (?,'home',?,?,'2026-01-01','2026-01-01')",
      )
        .bind(member, member, options.role ?? "member")
        .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO auth_accounts (member_id,email,password_hash,updated_at) VALUES (?,?,'fixture','2026-01-01')",
      ).bind(member, `${member}@cooking.test`),
      env.DB.prepare(
        "INSERT OR REPLACE INTO auth_sessions (token_hash,member_id,credential_version,expires_at,created_at) VALUES (?,?,1,'2099-01-01T00:00:00.000Z','2026-01-01')",
      ).bind(await digest(token), member),
    ]);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-HomeOS-Member": member,
    "X-Operation-ID": options.operation ?? crypto.randomUUID(),
  };
  if (options.authenticated !== false)
    headers.Cookie = `homeos_session=${token}`;
  if (options.version !== undefined)
    headers["If-Match"] = String(options.version);
  return app.request(
    `https://home-os.test/api/v1${path}`,
    {
      method,
      headers,
      ...(options.emptyBodyStream
        ? {
            body: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
    },
    env,
  );
}
export const recipeInput = {
  name: "Dal",
  servings: 4,
  ingredients: [{ name: "Lentils", quantity: 1, unit: "kg" }],
  instructions: "Simmer gently",
};
