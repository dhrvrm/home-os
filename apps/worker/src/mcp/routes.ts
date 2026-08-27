import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import type { Env } from "../env";
import { createHomeOSMcpServer } from "./server";

export function createMcpRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.all("/mcp", async (context) => {
    const configuredToken = context.env.HOMEOS_MCP_TOKEN;
    if (!configuredToken) {
      return context.json({ error: "MCP is not configured." }, 503);
    }
    const suppliedToken = bearerToken(context.req.header("Authorization"));
    if (!suppliedToken || !(await secureEqual(suppliedToken, configuredToken))) {
      context.header("WWW-Authenticate", 'Bearer realm="home-os-mcp"');
      return context.json({ error: "Unauthorized." }, 401);
    }

    const handler = createMcpHandler(() => createHomeOSMcpServer(context.env), {
      route: "/mcp",
      legacy: "stateless",
      corsOptions: false,
    });
    return handler.fetch(context.req.raw);
  });

  return routes;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}
