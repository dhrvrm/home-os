import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import type { JWTPayload } from "jose";
import { createAuth } from "../auth/auth";
import type { AppContext } from "../auth/context";
import {
  HOME_OS_MCP_PATH,
  HOME_OS_ORGANIZATION_CLAIM,
} from "../auth/constants";
import { resolveOrganizationHousehold } from "../auth/households";
import { createHomeOSMcpServer } from "./server";

interface McpMembershipRow {
  membership_id: string;
  organization_id: string;
  organization_name: string;
}

export function createMcpRoutes(): Hono<AppContext> {
  const routes = new Hono<AppContext>();

  routes.all(HOME_OS_MCP_PATH, async (context) => {
    const auth = createAuth(context.env);
    const baseURL = context.env.BETTER_AUTH_URL.replace(/\/+$/, "");
    const resource = `${baseURL}${HOME_OS_MCP_PATH}`;
    const token = bearerToken(context.req.header("Authorization"));
    if (!token) return authenticationRequired(resource);

    const { payload } = await auth.api.verifyJWT({
      body: { token, issuer: `${baseURL}/api/auth` },
    });
    if (!payload || !hasRequiredScopes(payload.scope)) {
      return authenticationRequired(resource, payload ? "insufficient_scope" : "invalid_token");
    }
    return serveAuthorizedMcp(context.req.raw, payload, context.env);
  });

  return routes;
}

async function serveAuthorizedMcp(
  request: Request,
  claims: JWTPayload,
  env: AppContext["Bindings"],
): Promise<Response> {
  const userId = claims.sub;
  const organizationId = claims[HOME_OS_ORGANIZATION_CLAIM];
  const sessionId = claims.sid;
  if (
    typeof userId !== "string" ||
    typeof organizationId !== "string" ||
    typeof sessionId !== "string"
  ) {
    return authorizationDenied("The access token is not bound to a Home OS organization.");
  }

  const session = await env.DB.prepare(
    `SELECT id FROM session
     WHERE id = ? AND userId = ? AND expiresAt > ?`,
  )
    .bind(sessionId, userId, new Date().getTime())
    .first<{ id: string }>();
  if (!session) return authorizationDenied("The Home OS session has ended.");

  const membership = await env.DB.prepare(
    `SELECT m.id AS membership_id,
            o.id AS organization_id,
            o.name AS organization_name
     FROM member m
     INNER JOIN organization o ON o.id = m.organizationId
     WHERE m.userId = ? AND m.organizationId = ?`,
  )
    .bind(userId, organizationId)
    .first<McpMembershipRow>();
  if (!membership) {
    return authorizationDenied("Organization access has been revoked.");
  }

  const household = await resolveOrganizationHousehold(
    env.DB,
    { id: membership.organization_id, name: membership.organization_name },
    env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
  );
  const handler = createMcpHandler(() => createHomeOSMcpServer(env, household.id), {
    route: HOME_OS_MCP_PATH,
    legacy: "stateless",
    corsOptions: false,
    authContext: {
      props: {
        userId,
        organizationId,
        membershipId: membership.membership_id,
        householdId: household.id,
      },
    },
  });
  return handler.fetch(request);
}

function authorizationDenied(message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32003, message }, id: null },
    { status: 403 },
  );
}

function authenticationRequired(
  resource: string,
  error?: "invalid_token" | "insufficient_scope",
): Response {
  const metadataURL = `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`;
  const challenge = [
    `Bearer resource_metadata="${metadataURL}"`,
    'scope="inventory:read activity:read"',
    ...(error ? [`error="${error}"`] : []),
  ].join(", ");
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "OAuth authorization required." }, id: null }),
    { status: error === "insufficient_scope" ? 403 : 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge } },
  );
}

function bearerToken(header: string | undefined): string | null {
  return header?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? null;
}

function hasRequiredScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const scopes = new Set(value.split(/\s+/).filter(Boolean));
  return scopes.has("inventory:read") && scopes.has("activity:read");
}
