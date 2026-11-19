import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env";
import type { VerifiedAuthority } from "../auth/authority";
import { createHomeOSMcpServer } from "./server";

/** Only the OAuth provider's freshly resolved personal actor enters this transport. */
export function handleMcpRequest(request: Request, env: Env, authority: VerifiedAuthority, clientId: string): Promise<Response> {
  const handler = createMcpHandler(() => createHomeOSMcpServer(env, authority, clientId), {
    route: "/mcp", legacy: "stateless", corsOptions: false,
  });
  return handler.fetch(request);
}
