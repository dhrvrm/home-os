import { captureAccessProof, signalSessionExpired } from "@/auth/work";
import { canCoordinateBrowserAuth, withBrowserAuthHandshake } from "@/auth/browser-handshake";
import { request } from "./api";

export interface AuthUser {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: "owner" | "member" | "viewer";
}
export interface AuthSession { user: AuthUser; expiresAt: string | null }
export interface AuthStatus { setupRequired: boolean; setupAvailable: boolean; session: AuthSession | null }
export interface MemberAccount {
  id: string;
  name: string;
  email: string | null;
  role: AuthUser["role"];
  active: boolean;
  hasLogin: boolean;
}

export function getAuthStatus(): Promise<AuthStatus> {
  if (!canCoordinateBrowserAuth()) return request("/api/v1/auth/status");
  return withBrowserAuthHandshake(() => request("/api/v1/auth/status", { headers: { "X-HomeOS-Session-Renew": "1" } }), false);
}
export function login(input: { email: string; password: string }): Promise<AuthSession> {
  return withBrowserAuthHandshake(() => request("/api/v1/auth/login", { method: "POST", body: JSON.stringify(input) }));
}
export function setupOwner(input: { name: string; email: string; password: string; setupToken: string }): Promise<AuthSession> {
  return withBrowserAuthHandshake(() => request("/api/v1/auth/setup", { method: "POST", body: JSON.stringify(input) }));
}
export async function logout(): Promise<void> { await request("/api/v1/auth/logout", { method: "POST", body: "{}" }); }
export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<AuthSession> {
  return withBrowserAuthHandshake(() => request("/api/v1/auth/password", { method: "POST", body: JSON.stringify(input) }));
}
export async function getMembers(): Promise<MemberAccount[]> {
  return (await request<{ members: MemberAccount[] }>("/api/v1/members")).members;
}
export async function createMember(input: { name: string; email: string; password: string; role: AuthUser["role"] }): Promise<MemberAccount> {
  return (await request<{ member: MemberAccount }>("/api/v1/members", { method: "POST", body: JSON.stringify(input) })).member;
}
export async function updateMember(id: string, input: { name?: string; email?: string; role?: AuthUser["role"]; active?: boolean }): Promise<MemberAccount> {
  return (await request<{ member: MemberAccount }>(`/api/v1/members/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) })).member;
}
export async function resetMemberPassword(id: string, password: string): Promise<void> {
  await request(`/api/v1/members/${encodeURIComponent(id)}/password`, { method: "POST", body: JSON.stringify({ password }) });
}

export interface BrowserSessionAccess {
  id: string;
  memberId: string;
  createdAt: string;
  expiresAt: string | null;
  current: boolean;
}
export function listBrowserSessions(input: { memberId?: string; limit?: number; cursor?: string } = {}): Promise<{ sessions: BrowserSessionAccess[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (input.memberId !== undefined) query.set("memberId", input.memberId);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  return request(`/api/v1/auth/sessions${query.size ? `?${query}` : ""}`);
}
export async function revokeBrowserSession(id: string): Promise<{ id: string; revoked: true; current: boolean }> {
  const proof = captureAccessProof();
  const result = await request<{ id: string; revoked: true; current: boolean }>(`/api/v1/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
  if (result.current) signalSessionExpired(proof);
  return result;
}
