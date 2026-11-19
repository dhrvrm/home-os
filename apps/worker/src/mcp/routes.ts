import { createMcpHandler } from "agents/mcp/server";
import { boundedLedgerBody } from "../http/body";
import { HomeOSError } from "../platform/errors";
import type { Env } from "../env";
import type { VerifiedAuthority } from "../auth/authority";
import { createHomeOSMcpServer } from "./server";

/** Only the OAuth provider's freshly resolved personal actor enters this transport. */
export async function handleMcpRequest(request: Request, env: Env, authority: VerifiedAuthority, clientId: string): Promise<Response> {
  if (request.method === 'POST') {
    try {
      const bytes = await boundedLedgerBody(request);
      request = new Request(request, { body: bytes });
    } catch (error) {
      if (error instanceof HomeOSError) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message, data: { code: error.code } } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
      throw error;
    }
  }
  const handler = createMcpHandler(() => createHomeOSMcpServer(env, authority, clientId), {
    route: "/mcp", legacy: "stateless", corsOptions: false,
  });
  return handler.fetch(request);
}
