import { getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { failure } from "../http/envelope";
import { HomeOSError } from "../platform/errors";
import { digest, randomToken } from "./crypto";

export interface AuthUser {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: "owner" | "member" | "viewer";
}

export interface AuthSession { user: AuthUser; expiresAt: string }
export type AuthContext = Context<{ Bindings: Env }>;

declare module "hono" {
  interface ContextVariableMap { member: AuthUser }
}

const COOKIE = "homeos_session";
export const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const SESSION_SECONDS = 12 * 60 * 60;

export function passwordPepper(env: Env): string {
  if (!env.HOMEOS_PASSWORD_PEPPER || env.HOMEOS_PASSWORD_PEPPER.length < 32) {
    throw new HomeOSError("Sign-in is not configured. Ask the home administrator to configure authentication.", "auth_unavailable", 503);
  }
  return env.HOMEOS_PASSWORD_PEPPER;
}

export function currentMember(context: AuthContext): AuthUser {
  const member = context.get("member");
  if (!member) throw new HomeOSError("Sign in to continue.", "unauthorized", 401);
  return member;
}

export function requireOwner(context: AuthContext): AuthUser {
  const member = currentMember(context);
  if (member.role !== "owner") throw new HomeOSError("Only a home owner can manage members.", "forbidden", 403);
  return member;
}

export async function readSession(context: AuthContext): Promise<AuthSession | null> {
  const token = getCookie(context, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await context.env.DB.prepare(
    `SELECT m.id, m.household_id, m.display_name, a.email, m.role, s.expires_at
       FROM auth_sessions s JOIN members m ON m.id = s.member_id
       JOIN auth_accounts a ON a.member_id = m.id
      WHERE s.token_hash = ? AND s.expires_at > ? AND m.archived_at IS NULL AND m.household_id = ?
        AND s.credential_version = a.credential_version`,
  ).bind(await digest(token), new Date().toISOString(), context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
    .first<{ id: string; household_id: string; display_name: string; email: string; role: AuthUser["role"]; expires_at: string }>();
  if (!row) return null;
  return { user: { id: row.id, householdId: row.household_id, name: row.display_name, email: row.email, role: row.role }, expiresAt: row.expires_at };
}

export async function createSession(context: AuthContext, user: AuthUser, remember: boolean, credentialVersion: number): Promise<AuthSession> {
  const token = randomToken();
  const now = new Date();
  const seconds = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  const expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now.toISOString()),
    context.env.DB.prepare("INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await digest(token), user.id, credentialVersion, expiresAt, now.toISOString()),
  ]);
  setCookie(context, COOKIE, token, { path: "/", httpOnly: true, sameSite: "Strict", secure: new URL(context.req.url).protocol === "https:", ...(remember ? { maxAge: seconds } : {}) });
  return { user, expiresAt };
}

export async function revokeCurrentSession(context: AuthContext): Promise<void> {
  const token = getCookie(context, COOKIE);
  if (token) await context.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await digest(token)).run();
  setCookie(context, COOKIE, "", { path: "/", httpOnly: true, sameSite: "Strict", secure: new URL(context.req.url).protocol === "https:", maxAge: 0 });
}

export const protectHousehold: MiddlewareHandler<{ Bindings: Env }> = async (context, next) => {
  context.header("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    const origin = context.req.header("Origin");
    if ((origin && origin !== new URL(context.req.url).origin) || context.req.header("Sec-Fetch-Site") === "cross-site") {
      return failure(context, { code: "forbidden", message: "This request must come from Home OS." }, 403);
    }
    if (context.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return failure(context, { code: "invalid_request", message: "Send household changes as JSON." }, 415);
    }
  }
  if (["/api/v1/auth/status", "/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/logout"].includes(context.req.path)) return next();
  // Unknown auth routes remain 404 rather than revealing household state.
  if (context.req.path.startsWith("/api/v1/auth/") && !["/api/v1/auth/password"].includes(context.req.path)) return next();
  const session = await readSession(context);
  if (!session) return failure(context, { code: "unauthorized", message: "Your session has ended. Sign in again to continue." }, 401);
  const expectedMember = context.req.header("X-HomeOS-Member");
  const changesHousehold = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
  if ((changesHousehold && !expectedMember) || (expectedMember && expectedMember !== session.user.id)) {
    return failure(context, { code: "session_changed", message: "Another account signed in on this device. Reopen Home OS before continuing." }, 409);
  }
  context.set("member", session.user);
  if (session.user.role === "viewer" && context.req.path !== "/api/v1/auth/password" && !["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
    return failure(context, { code: "forbidden", message: "Your account has read-only access." }, 403);
  }
  return next();
};
