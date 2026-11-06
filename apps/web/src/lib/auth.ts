import { request } from "./api";

export interface AuthUser {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: "owner" | "member" | "viewer";
}
export interface AuthSession { user: AuthUser; expiresAt: string }
export interface AuthStatus { setupRequired: boolean; setupAvailable: boolean; session: AuthSession | null }
export interface MemberAccount {
  id: string;
  name: string;
  email: string | null;
  role: AuthUser["role"];
  active: boolean;
  hasLogin: boolean;
}

export function getAuthStatus(): Promise<AuthStatus> { return request("/api/v1/auth/status"); }
export function login(input: { email: string; password: string; remember: boolean }): Promise<AuthSession> {
  return request("/api/v1/auth/login", { method: "POST", body: JSON.stringify(input) });
}
export function setupOwner(input: { name: string; email: string; password: string; setupToken: string; remember: boolean }): Promise<AuthSession> {
  return request("/api/v1/auth/setup", { method: "POST", body: JSON.stringify(input) });
}
export async function logout(): Promise<void> { await request("/api/v1/auth/logout", { method: "POST", body: "{}" }); }
export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<AuthSession> {
  return request("/api/v1/auth/password", { method: "POST", body: JSON.stringify(input) });
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
