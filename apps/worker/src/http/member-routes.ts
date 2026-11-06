import { Hono } from "hono";
import type { Env } from "../env";
import { z } from "zod";
import { accessAudit, emailSchema, nameSchema, passwordSchema } from "../auth/support";
import { hashPassword } from "../auth/crypto";
import { passwordPepper, requireOwner } from "../auth/session";
import { createId } from "../platform/ids";
import { HomeOSError, NotFoundError } from "../platform/errors";
import { parsedJSON } from "./body";
import { success } from "./envelope";

interface MemberRow {
  id: string;
  display_name: string;
  archived_at: string | null;
  email: string | null;
  role: "owner" | "member" | "viewer";
  has_login: number;
}

function mapMember(row: MemberRow) {
  return { id: row.id, name: row.display_name, email: row.email, role: row.role, active: row.archived_at === null, hasLogin: !!row.has_login };
}

function memberConflict(error: unknown): never {
  if (String(error).includes("last_active_owner")) throw new HomeOSError("Keep at least one active home owner.", "last_owner", 409);
  if (String(error).includes("UNIQUE constraint")) throw new HomeOSError("That email already belongs to a member.", "email_in_use", 409);
  throw error;
}

export function createMemberRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/members", async (context) => {
    const result = await context.env.DB.prepare(
      `SELECT m.id, m.display_name, m.email, m.role, m.archived_at,
         EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) AS has_login
       FROM members m WHERE m.household_id = ? ORDER BY m.display_name COLLATE NOCASE, m.id`,
    )
      .bind(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
      .all<MemberRow>();
    const members = result.results.map(mapMember);
    return success(context, { members });
  });

  routes.post("/members", async (context) => {
    const owner = requireOwner(context);
    const input = await parsedJSON(context, z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, role: z.enum(["owner", "member", "viewer"]).default("member") }));
    const id = createId();
    const now = new Date().toISOString();
    const hash = await hashPassword(input.password, passwordPepper(context.env));
    try {
      await context.env.DB.batch([
        context.env.DB.prepare("INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(id, owner.householdId, input.name, input.email, input.role, now, now),
        context.env.DB.prepare("INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES (?, ?, ?, ?)").bind(id, input.email, hash, now),
        accessAudit(context, owner.id, id, "member.created"),
      ]);
    } catch (error) { memberConflict(error); }
    return success(context, { member: { id, name: input.name, email: input.email, role: input.role, active: true, hasLogin: true } }, 201);
  });

  routes.patch("/members/:id", async (context) => {
    const owner = requireOwner(context);
    const id = context.req.param("id");
    const input = await parsedJSON(context, z.object({ name: nameSchema.optional(), email: emailSchema.optional(), role: z.enum(["owner", "member", "viewer"]).optional(), active: z.boolean().optional() }).strict());
    const row = await context.env.DB.prepare(`SELECT m.id, m.display_name, m.email, m.role, m.archived_at,
        EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) AS has_login
        FROM members m WHERE m.id = ? AND m.household_id = ?`).bind(id, owner.householdId).first<MemberRow>();
    if (!row) throw new NotFoundError("member", id);
    if (input.email !== undefined) {
      const duplicate = await context.env.DB.prepare("SELECT member_id FROM auth_accounts WHERE email = ? COLLATE NOCASE AND member_id <> ?")
        .bind(input.email, id).first();
      if (duplicate) throw new HomeOSError("That email already belongs to a member.", "email_in_use", 409);
    }
    const now = new Date().toISOString();
    const assignments = ["updated_at = ?"];
    const values: unknown[] = [now];
    if (input.name !== undefined) { assignments.push("display_name = ?"); values.push(input.name); }
    if (input.email !== undefined) { assignments.push("email = ?"); values.push(input.email); }
    if (input.role !== undefined) { assignments.push("role = ?"); values.push(input.role); }
    if (input.active !== undefined) { assignments.push("archived_at = ?"); values.push(input.active ? null : now); }
    try {
      const results = await context.env.DB.batch<MemberRow>([
        context.env.DB.prepare(`UPDATE members SET ${assignments.join(", ")} WHERE id = ? AND household_id = ?`)
          .bind(...values, id, owner.householdId),
        ...(input.email !== undefined ? [context.env.DB.prepare("UPDATE auth_accounts SET email = ?, updated_at = ? WHERE member_id = ?").bind(input.email, now, id)] : []),
        ...(input.active === false ? [context.env.DB.prepare("DELETE FROM auth_sessions WHERE member_id = ?").bind(id)] : []),
        accessAudit(context, owner.id, id, input.active === false ? "member.deactivated" : input.active === true ? "member.reactivated" : "member.updated"),
        context.env.DB.prepare(`SELECT m.id, m.display_name, m.email, m.role, m.archived_at,
          EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) AS has_login
          FROM members m WHERE m.id = ? AND m.household_id = ?`).bind(id, owner.householdId),
      ]);
      const updated = results.at(-1)?.results[0];
      if (!updated) throw new NotFoundError("member", id);
      return success(context, { member: mapMember(updated) });
    } catch (error) { memberConflict(error); }
  });

  routes.post("/members/:id/password", async (context) => {
    const owner = requireOwner(context);
    const id = context.req.param("id");
    if (id === owner.id) throw new HomeOSError("Change your own password in Account using your current password.", "invalid_request", 400);
    const input = await parsedJSON(context, z.object({ password: passwordSchema }));
    const member = await context.env.DB.prepare("SELECT email FROM members WHERE id = ? AND household_id = ?").bind(id, owner.householdId).first<{ email: string | null }>();
    if (!member) throw new NotFoundError("member", id);
    if (!member.email) throw new HomeOSError("Add an email to this member before setting a password.", "invalid_request", 400);
    const hash = await hashPassword(input.password, passwordPepper(context.env));
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(`INSERT INTO auth_accounts (member_id, email, password_hash, updated_at)
          SELECT id, email, ?, ? FROM members WHERE id = ? AND household_id = ? AND email IS NOT NULL
          ON CONFLICT (member_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
          credential_version = credential_version + 1, updated_at = excluded.updated_at`)
          .bind(hash, new Date().toISOString(), id, owner.householdId),
        context.env.DB.prepare("DELETE FROM auth_sessions WHERE member_id = ?").bind(id),
        accessAudit(context, owner.id, id, "member.password_reset"),
      ]);
    } catch (error) { memberConflict(error); }
    return success(context, { reset: true });
  });

  return routes;
}
