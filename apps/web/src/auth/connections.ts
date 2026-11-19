import { request } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";

export const MCP_RESOURCE = "https://home.dhruvverma.dev/mcp";
export interface AssistantConnection {
  id: string; memberId: string; clientId: string; clientName: string; resource: string;
  approvedRole: AuthUser["role"]; status: "authorized" | "not_used_yet" | "ended";
  createdAt: string; approvedAt: string | null; endedAt: string | null;
}
export interface ConsentPreview {
  id: string;
  client: { clientId: string; clientName: string; clientDomain?: string; clientUri?: string; logoUri?: string; redirectUri: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] };
  resource: string;
  member: { id: string; name: string; role: AuthUser["role"] };
  approvedRole: AuthUser["role"]; capabilities: string[]; expiresAt: string;
}
export function listConnections(input: { memberId?: string; limit?: number; cursor?: string } = {}): Promise<{ connections: AssistantConnection[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
  return request(`/api/v1/auth/connections${query.size ? `?${query}` : ""}`);
}
export function revokeConnection(id: string): Promise<{ id: string; revoked: true }> {
  return request(`/api/v1/auth/connections/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
}
export function getConsent(id: string): Promise<ConsentPreview> {
  return request(`/api/v1/auth/consent/${encodeURIComponent(id)}`);
}
export function decideConsent(id: string, decision: "approve" | "deny"): Promise<{ redirectTo: string }> {
  return request(`/api/v1/auth/consent/${encodeURIComponent(id)}/${decision}`, { method: "POST", body: "{}" });
}
