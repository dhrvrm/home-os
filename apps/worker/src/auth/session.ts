import { sessionLifetimeSQL } from "./session-policy";
import type { VerifiedAuthority } from "./authority";
import { capabilities, permits, httpAction, type Action } from "./permissions";
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

export interface AuthSession { sessionId: string; user: AuthUser; expiresAt: string | null; capabilities: Action[] }
export interface DeviceGrant { tokenHash: string; expiresAt: string | null; credentialVersion: number }
export type AuthContext = Context<{ Bindings: Env }>;

declare module "hono" {
  interface ContextVariableMap { member: AuthUser; deviceGrant: DeviceGrant }
}

const COOKIE = "homeos_session";
export const COOKIE_RETENTION_SECONDS = 400 * 24 * 60 * 60;

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

export function currentAuthority(context: AuthContext): VerifiedAuthority {
  const member = currentMember(context);
  const grant = currentDeviceGrant(context);
  return { memberId: member.id, householdId: member.householdId, role: member.role, proof: { kind: "browser", tokenHash: grant.tokenHash, credentialVersion: grant.credentialVersion } };
}

export function currentDeviceGrant(context: AuthContext): DeviceGrant {
  const grant = context.get("deviceGrant");
  if (!grant) throw new HomeOSError("Sign in to enable device reminders.", "unauthorized", 401);
  return grant;
}

export async function hasNotificationDeliveryAuthority(database: D1Database, householdId: string, memberId: string, tokenHash: string, now: string): Promise<boolean> {
  const grant = await database.prepare(`SELECT 1 AS admitted FROM auth_sessions s
    JOIN members m ON m.id = s.member_id JOIN auth_accounts a ON a.member_id = m.id
    WHERE s.token_hash = ? AND m.household_id = ? AND m.id = ? AND m.archived_at IS NULL
      AND ${sessionLifetimeSQL("s")} AND s.credential_version = a.credential_version`)
    .bind(tokenHash, householdId, memberId, now).first();
  return grant !== null;
}

async function readSessionWithGrant(context: AuthContext, renewCookie = false): Promise<(AuthSession & { grant: DeviceGrant }) | null> {
  const token = getCookie(context, COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const row = await context.env.DB.prepare(
    `SELECT m.id, m.household_id, m.display_name, a.email, m.role, s.public_id, s.expires_at, s.permanent, s.credential_version
       FROM auth_sessions s JOIN members m ON m.id = s.member_id
       JOIN auth_accounts a ON a.member_id = m.id
      WHERE s.token_hash = ? AND ${sessionLifetimeSQL("s")} AND m.archived_at IS NULL AND m.household_id = ?
        AND s.credential_version = a.credential_version`,
  ).bind(tokenHash, new Date().toISOString(), context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
    .first<{ id: string; household_id: string; display_name: string; email: string; role: AuthUser["role"]; public_id: string; expires_at: string; permanent: number; credential_version: number }>();
  if (!row) return null;
  if (row.permanent === 0) {
    // A rolling old runtime may create a legacy row after migration backfill.
    // Upgrade only the still-current grant once; expired/replaced rows stay ended.
    const upgraded = await context.env.DB.prepare(`UPDATE auth_sessions SET permanent = 1
      WHERE token_hash = ? AND permanent = 0 AND credential_version = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
        WHERE m.id = auth_sessions.member_id AND m.household_id = ? AND m.archived_at IS NULL
          AND a.credential_version = auth_sessions.credential_version) RETURNING permanent`)
      .bind(tokenHash, row.credential_version, new Date().toISOString(), row.household_id).first();
    if (!upgraded) return readSessionWithGrant(context, renewCookie);
    row.permanent = 1;
  }
  // Only coordinated status requests renew retention. An ordinary delayed
  // response must never install its old proof over a later sign-in's cookie.
  if (renewCookie) renewSessionCookie(context, token);
  const expiresAt = row.permanent === 1 ? null : row.expires_at;
  return { sessionId: row.public_id, capabilities: capabilities({ memberId: row.id, householdId: row.household_id, role: row.role, kind: "browser" }), user: { id: row.id, householdId: row.household_id, name: row.display_name, email: row.email, role: row.role }, expiresAt,
    grant: { tokenHash, expiresAt, credentialVersion: row.credential_version } };
}

export async function readSession(context: AuthContext, renewCookie = false): Promise<AuthSession | null> {
  const session = await readSessionWithGrant(context, renewCookie);
  return session ? { sessionId: session.sessionId, user: session.user, expiresAt: session.expiresAt, capabilities: session.capabilities } : null;
}

function renewSessionCookie(context: AuthContext, token: string): void {
  setCookie(context, COOKIE, token, { path: "/", httpOnly: true, sameSite: "Strict", secure: new URL(context.req.url).protocol === "https:", maxAge: COOKIE_RETENTION_SECONDS });
}

export async function createSession(context: AuthContext, user: AuthUser, credentialVersion: number): Promise<AuthSession> {
  const token = randomToken();
  const sessionId = crypto.randomUUID().replaceAll("-", "");
  const now = new Date().toISOString();
  // Ordinary legacy metadata protects fresh rows from an in-flight old runtime's
  // expiry cleanup during rollout. Only permanent controls current admission.
  const legacyExpiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`DELETE FROM auth_sessions WHERE NOT ${sessionLifetimeSQL("auth_sessions")}`).bind(now),
    context.env.DB.prepare(`INSERT INTO auth_sessions (token_hash, public_id, member_id, credential_version, expires_at, created_at, permanent)
      SELECT ?, ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
      WHERE m.id = ? AND m.household_id = ? AND m.archived_at IS NULL AND a.credential_version = ?)`)
      .bind(await digest(token), sessionId, user.id, credentialVersion, legacyExpiresAt, now, user.id, user.householdId, credentialVersion),
  ]);
  if (results[1]!.meta.changes !== 1) throw new HomeOSError("Your access changed. Sign in again.", "unauthorized", 401);
  renewSessionCookie(context, token);
  return { sessionId, user, expiresAt: null, capabilities: capabilities({ memberId: user.id, householdId: user.householdId, role: user.role, kind: "browser" }) };
}

export async function revokeCurrentSession(context: AuthContext): Promise<void> {
  const token = getCookie(context, COOKIE);
  if (token) await context.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await digest(token)).run();
  // The revoked proof is inert. Clearing the origin's shared cookie here could
  // erase a newer sign-in whose response completed while this one was pending.
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
  if (context.req.path.startsWith("/api/v1/auth/") && !["/api/v1/auth/password", "/api/v1/auth/sessions"].includes(context.req.path) && !/^\/api\/v1\/auth\/(sessions|connections)\/[^/]+\/revoke$/.test(context.req.path) && context.req.path !== "/api/v1/auth/connections" && !/^\/api\/v1\/auth\/consent\/[^/]+(?:\/(?:approve|deny))?$/.test(context.req.path)) return next();
  const session = await readSessionWithGrant(context);
  if (!session) return failure(context, { code: "unauthorized", message: "Your session has ended. Sign in again to continue." }, 401);
  const expectedMember = context.req.header("X-HomeOS-Member");
  const changesHousehold = !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
  if ((changesHousehold && !expectedMember) || (expectedMember && expectedMember !== session.user.id)) {
    return failure(context, { code: "session_changed", message: "Another account signed in on this device. Reopen Home OS before continuing." }, 409);
  }
  context.set("member", session.user);
  context.set("deviceGrant", session.grant);
  const action = httpAction(context.req.method, context.req.path);
  if (action && !permits({ memberId: session.user.id, householdId: session.user.householdId, role: session.user.role, kind: "browser" }, action, { householdId: session.user.householdId, memberId: session.user.id })) {
    return failure(context, { code: "forbidden", message: "Your account cannot perform this action." }, 403);
  }
  return next();
};
