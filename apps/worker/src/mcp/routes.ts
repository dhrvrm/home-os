import { createMcpHandler } from "agents/mcp/server";
import { boundedRequestBody, decodeRequestUTF8 } from "../http/body";
import { HomeOSError } from "../platform/errors";
import type { Env } from "../env";
import type { VerifiedAuthority } from "../auth/authority";
import { createHomeOSMcpServer } from "./server";

const MAX_MCP_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_FINANCIAL_FRAME_BYTES = 64 * 1024;
function isFinancialCall(message: unknown): boolean {
  if (!message || typeof message !== 'object' || !('method' in message) || message.method !== 'tools/call' || !('params' in message)) return false;
  const params = message.params;
  return !!params && typeof params === 'object' && 'name' in params && typeof params.name === 'string' && params.name.startsWith('ledger_');
}

/** Only the OAuth provider's freshly resolved personal actor enters this transport. */
export async function handleMcpRequest(request: Request, env: Env, authority: VerifiedAuthority, clientId: string): Promise<Response> {
  if (request.method === 'POST') {
    try {
      const bytes = await boundedRequestBody(request, MAX_MCP_FRAME_BYTES, () => new HomeOSError('MCP requests must be at most 4 MiB', 'payload_too_large', 413));
      let text: string, frame: unknown;
      try {
        text = decodeRequestUTF8(bytes);
        frame = JSON.parse(text);
      } catch {
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }
      const messages = Array.isArray(frame) ? frame : [frame];
      if (messages.some(isFinancialCall) && bytes.byteLength > MAX_FINANCIAL_FRAME_BYTES) {
        throw new HomeOSError('Ledger requests must be at most 64 KiB', 'payload_too_large', 413);
      }
      // Forward the same decoded text, preserving escaping/duplicate-key/BOM meaning.
      // SDK validation, initialization, notification and batch handling remain authoritative.
      request = new Request(request, { body: text });
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
