import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { parsedJSON } from "../http/body";
import { success } from "../http/envelope";
import { accessAudit, emailSchema, nameSchema, passwordSchema } from "./support";
import { createId } from "../platform/ids";
import { HomeOSError } from "../platform/errors";
import { digest, equalSecrets, hashPassword, verifyPassword } from "./crypto";
import { createSession, currentMember, passwordPepper, readSession, revokeCurrentSession, type AuthContext, type AuthUser } from "./session";

export async function rateLimit(context: AuthContext, name: string, limit: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 900) * 900;
  const key = await digest(name);
  const row = await context.env.DB.prepare(
    `INSERT INTO auth_attempts (attempt_key, window_start, attempts) VALUES (?, ?, 1)
     ON CONFLICT (attempt_key) DO UPDATE SET
       attempts = CASE WHEN window_start = excluded.window_start THEN attempts + 1 ELSE 1 END,
       window_start = excluded.window_start RETURNING attempts`,
  ).bind(key, windowStart).first<{ attempts: number }>();
  await context.env.DB.prepare("DELETE FROM auth_attempts WHERE window_start < ?").bind(now - 86400).run();
  if ((row?.attempts ?? 0) > limit) {
    context.header("Retry-After", String(windowStart + 900 - now));
    throw new HomeOSError("Too many attempts. Wait a few minutes before trying again.", "rate_limited", 429);
  }
}

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128), remember: z.boolean().default(false) });
const setupSchema = loginSchema.extend({ name: nameSchema, password: passwordSchema, setupToken: z.string().min(1).max(256) });

export function createAuthRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/auth/status", async (context) => {
    const configured = !!context.env.HOMEOS_SETUP_TOKEN && (context.env.HOMEOS_PASSWORD_PEPPER?.length ?? 0) >= 32;
    const bootstrapped = await context.env.DB.prepare("SELECT household_id FROM auth_bootstrap WHERE household_id = ?")
      .bind(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID).first();
    return success(context, { setupRequired: !bootstrapped, setupAvailable: configured, session: await readSession(context) });
  });

  routes.post("/auth/setup", async (context) => {
    const pepper = passwordPepper(context.env);
    await rateLimit(context, `setup:${context.req.header("CF-Connecting-IP") ?? "local"}`, 10);
    const input = await parsedJSON(context, setupSchema);
    if (!context.env.HOMEOS_SETUP_TOKEN || !(await equalSecrets(input.setupToken, context.env.HOMEOS_SETUP_TOKEN))) {
      throw new HomeOSError("The home setup key is incorrect. Ask the administrator for the setup key.", "forbidden", 403);
    }
    const householdId = context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID;
    const existing = await context.env.DB.prepare("SELECT household_id FROM auth_bootstrap WHERE household_id = ?").bind(householdId).first();
    if (existing) throw new HomeOSError("This home is already set up. Sign in with your email and password.", "already_configured", 409);
    const initialOwner = await context.env.DB.prepare("SELECT id FROM members WHERE household_id = ? AND role = 'owner' ORDER BY created_at, id LIMIT 1")
      .bind(householdId).first<{ id: string }>();
    const id = initialOwner?.id ?? createId();
    const now = new Date().toISOString();
    const hash = await hashPassword(input.password, pepper);
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO auth_bootstrap (household_id, created_at) VALUES (?, ?)").bind(householdId, now),
        context.env.DB.prepare(`INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'owner', ?, ?) ON CONFLICT (id) DO UPDATE SET
          display_name = excluded.display_name, email = excluded.email, role = 'owner', archived_at = NULL, updated_at = excluded.updated_at`)
          .bind(id, householdId, input.name, input.email, now, now),
        context.env.DB.prepare("INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES (?, ?, ?, ?)").bind(id, input.email, hash, now),
        accessAudit(context, id, id, "member.owner_established"),
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint")) throw new HomeOSError("This home is already set up. Sign in instead.", "already_configured", 409);
      throw error;
    }
    return success(context, await createSession(context, { id, householdId, name: input.name, email: input.email, role: "owner" }, input.remember, 1), 201);
  });

  routes.post("/auth/login", async (context) => {
    const pepper = passwordPepper(context.env);
    await rateLimit(context, `login-ip:${context.req.header("CF-Connecting-IP") ?? "local"}`, 60);
    const input = await parsedJSON(context, loginSchema);
    await rateLimit(context, `login-email:${input.email}`, 10);
    const row = await context.env.DB.prepare(
      `SELECT a.member_id, a.email, a.password_hash, a.credential_version, m.display_name, m.role
       FROM auth_accounts a JOIN members m ON m.id = a.member_id
       WHERE a.email = ? COLLATE NOCASE AND m.household_id = ? AND m.archived_at IS NULL`,
    ).bind(input.email, context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
      .first<{ member_id: string; email: string; password_hash: string; credential_version: number; display_name: string; role: AuthUser["role"] }>();
    // Do the same expensive work for unknown emails to avoid an account oracle.
    const dummy = `pbkdf2-sha256$100000$${"0".repeat(64)}$${"0".repeat(64)}`;
    const valid = await verifyPassword(input.password, row?.password_hash ?? dummy, pepper);
    if (!row || !valid) throw new HomeOSError("Email or password is incorrect.", "invalid_credentials", 401);
    await revokeCurrentSession(context);
    return success(context, await createSession(context, {
      id: row.member_id, householdId: context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
      name: row.display_name, email: row.email, role: row.role,
    }, input.remember, row.credential_version));
  });

  routes.post("/auth/logout", async (context) => {
    await revokeCurrentSession(context);
    return success(context, { signedOut: true });
  });

  routes.post("/auth/password", async (context) => {
    const member = currentMember(context);
    const pepper = passwordPepper(context.env);
    await rateLimit(context, `password:${member.id}`, 10);
    const input = await parsedJSON(context, z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }));
    const account = await context.env.DB.prepare("SELECT password_hash, credential_version FROM auth_accounts WHERE member_id = ?")
      .bind(member.id).first<{ password_hash: string; credential_version: number }>();
    if (!account || !(await verifyPassword(input.currentPassword, account.password_hash, pepper))) {
      throw new HomeOSError("Your current password is incorrect.", "invalid_credentials", 400);
    }
    const hash = await hashPassword(input.newPassword, pepper);
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE auth_accounts SET password_hash = ?, credential_version = credential_version + 1, updated_at = ? WHERE member_id = ? AND credential_version = ?")
        .bind(hash, new Date().toISOString(), member.id, account.credential_version),
      context.env.DB.prepare("DELETE FROM auth_sessions WHERE member_id = ? AND credential_version <= ?").bind(member.id, account.credential_version),
      accessAudit(context, member.id, member.id, "member.password_changed", hash),
    ]);
    if (results[0]!.meta.changes !== 1) throw new HomeOSError("Your password changed elsewhere. Sign in again.", "unauthorized", 401);
    return success(context, await createSession(context, member, false, account.credential_version + 1));
  });

  return routes;
}
