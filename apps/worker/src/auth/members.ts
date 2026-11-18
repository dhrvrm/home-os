import { revokeMemberGrants } from "./session-policy";
import { z } from "zod";
import type { CommandContext } from "../platform/context";
import {
  beginCommand,
  commitCommand,
  replayCommand,
} from "../platform/household-command";
import { createId } from "../platform/ids";
import {
  HomeOSError,
  NotFoundError,
  ValidationError,
} from "../platform/errors";
import { digest, hashPassword } from "./crypto";
import { emailSchema, nameSchema, passwordSchema } from "./support";
export const createMemberSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(["owner", "member", "viewer"]).default("member"),
});
export const updateMemberSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.optional(),
    role: z.enum(["owner", "member", "viewer"]).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const resetMemberPasswordSchema = z.object({ password: passwordSchema });
function parseMemberInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(
      issue?.path.join(".") || "body",
      issue?.message ?? "is invalid",
    );
  }
  return parsed.data;
}
interface MemberRow {
  id: string;
  display_name: string;
  archived_at: string | null;
  email: string | null;
  role: "owner" | "member" | "viewer";
  has_login: number;
}
function mapMember(row: MemberRow) {
  return {
    id: row.id,
    name: row.display_name,
    email: row.email,
    role: row.role,
    active: row.archived_at === null,
    hasLogin: !!row.has_login,
  };
}
function memberConflict(error: unknown): never {
  if (String(error).includes("last_active_owner"))
    throw new HomeOSError(
      "Keep at least one active home owner.",
      "last_owner",
      409,
    );
  if (String(error).includes("UNIQUE constraint"))
    throw new HomeOSError(
      "That email already belongs to a member.",
      "email_in_use",
      409,
    );
  throw error;
}
const memberSelect = `SELECT m.id, m.display_name, m.email, m.role, m.archived_at,
 EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) AS has_login FROM members m WHERE m.id = ? AND m.household_id = ?`;
export class MemberService {
  constructor(readonly database: D1Database) {}
  async listMembers(householdId: string) {
    const rows = await this.database
      .prepare(
        `SELECT m.id, m.display_name, m.email, m.role, m.archived_at,
    EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) AS has_login FROM members m WHERE m.household_id = ? ORDER BY m.display_name COLLATE NOCASE, m.id`,
      )
      .bind(householdId)
      .all<MemberRow>();
    return rows.results.map(mapMember);
  }
  async createMember(
    context: CommandContext,
    value: z.input<typeof createMemberSchema>,
    pepper: string,
  ) {
    const input = parseMemberInput(createMemberSchema, value);
    // Key the secret portion so a receipt never becomes an unpeppered password oracle.
    const command = await beginCommand(
      this.database,
      context,
      "member",
      "member.created",
      undefined,
      { ...input, password: await digest(`${pepper}\0${input.password}`) },
      "member_access_setup",
    );
    const replay = await replayCommand<{
      member: ReturnType<typeof mapMember>;
    }>(this.database, command);
    if (replay) return replay;
    const id = createId(),
      now = new Date().toISOString(),
      hash = await hashPassword(input.password, pepper);
    const result = {
      member: {
        id,
        name: input.name,
        email: input.email,
        role: input.role,
        active: true,
        hasLogin: true,
      },
    };
    try {
      return await commitCommand(
        this.database,
        command,
        result,
        id,
        now,
        [
          this.database
            .prepare(
              "INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              id,
              context.householdId,
              input.name,
              input.email,
              input.role,
              now,
              now,
            ),
          this.database
            .prepare(
              "INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES (?, ?, ?, ?)",
            )
            .bind(id, input.email, hash, now),
        ],
        async () => {},
      );
    } catch (error) {
      memberConflict(error);
    }
  }
  async updateMember(
    context: CommandContext,
    id: string,
    value: z.input<typeof updateMemberSchema>,
  ) {
    const input = parseMemberInput(updateMemberSchema, value);
    const action =
      input.active === false
        ? "member.deactivated"
        : input.active === true
          ? "member.reactivated"
          : "member.updated";
    const command = await beginCommand(
      this.database,
      context,
      "member",
      action,
      id,
      input,
      "members_update",
    );
    const replay = await replayCommand<{
      member: ReturnType<typeof mapMember>;
    }>(this.database, command);
    if (replay) return replay;
    const row = await this.database
      .prepare(memberSelect)
      .bind(id, context.householdId)
      .first<MemberRow>();
    if (!row) throw new NotFoundError("member", id);
    if (input.email !== undefined) {
      const duplicate = await this.database
        .prepare(
          "SELECT member_id FROM auth_accounts WHERE email = ? COLLATE NOCASE AND member_id <> ?",
        )
        .bind(input.email, id)
        .first();
      if (duplicate)
        throw new HomeOSError(
          "That email already belongs to a member.",
          "email_in_use",
          409,
        );
    }
    const now = new Date().toISOString(),
      assignments = ["updated_at = ?"],
      values: (string | null)[] = [now];
    for (const [field, column] of [
      ["name", "display_name"],
      ["email", "email"],
      ["role", "role"],
    ] as const) {
      if (input[field] !== undefined) {
        assignments.push(`${column} = ?`);
        values.push(input[field]);
      }
    }
    if (input.active !== undefined) {
      assignments.push("archived_at = ?");
      values.push(input.active ? null : now);
    }
    const acceptedResult = {
      query: `SELECT json_object('member', json_object('id', m.id, 'name', m.display_name, 'email', m.email, 'role', m.role,
      'active', json(CASE WHEN m.archived_at IS NULL THEN 'true' ELSE 'false' END), 'hasLogin', json(CASE WHEN EXISTS (SELECT 1 FROM auth_accounts a WHERE a.member_id = m.id) THEN 'true' ELSE 'false' END))) FROM members m WHERE m.id = ? AND m.household_id = ?`,
      values: [id, context.householdId],
    };
    command.changes = [];
    try {
      return await commitCommand(
        this.database,
        command,
        { member: mapMember(row) },
        id,
        now,
        [
          this.database
            .prepare(
              `UPDATE members SET ${assignments.join(", ")} WHERE id = ? AND household_id = ?`,
            )
            .bind(...values, id, context.householdId),
          ...(input.email !== undefined
            ? [
                this.database
                  .prepare(
                    "UPDATE auth_accounts SET email = ?, updated_at = ? WHERE member_id = ?",
                  )
                  .bind(input.email, now, id),
              ]
            : []),
          ...(input.active === false
            ? revokeMemberGrants(this.database, id, "deactivated")
            : []),
        ],
        async () => {},
        acceptedResult,
      );
    } catch (error) {
      memberConflict(error);
    }
  }
  async resetPassword(
    context: CommandContext,
    id: string,
    value: z.input<typeof resetMemberPasswordSchema>,
    pepper: string,
  ) {
    if (id === context.actorId)
      throw new HomeOSError(
        "Change your own password in Account using your current password.",
        "invalid_request",
        400,
      );
    const input = parseMemberInput(resetMemberPasswordSchema, value);
    const command = await beginCommand(
      this.database,
      context,
      "member",
      "member.password_reset",
      id,
      { password: await digest(`${pepper}\0${input.password}`) },
      "member_password_reset",
    );
    const replay = await replayCommand<{ reset: boolean }>(
      this.database,
      command,
    );
    if (replay) return replay;
    const member = await this.database
      .prepare("SELECT email FROM members WHERE id = ? AND household_id = ?")
      .bind(id, context.householdId)
      .first<{ email: string | null }>();
    if (!member) throw new NotFoundError("member", id);
    if (!member.email)
      throw new HomeOSError(
        "Add an email to this member before setting a password.",
        "invalid_request",
        400,
      );
    const hash = await hashPassword(input.password, pepper),
      now = new Date().toISOString();
    command.changes = [];
    try {
      return await commitCommand(
        this.database,
        command,
        { reset: true },
        id,
        now,
        [
          this.database
            .prepare(
              `INSERT INTO auth_accounts (member_id, email, password_hash, updated_at)
      SELECT id, email, ?, ? FROM members WHERE id = ? AND household_id = ? AND email IS NOT NULL
      ON CONFLICT (member_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
      credential_version = credential_version + 1, updated_at = excluded.updated_at`,
            )
            .bind(hash, now, id, context.householdId),
          ...revokeMemberGrants(this.database, id, "credentials"),
        ],
        async () => {},
      );
    } catch (error) {
      memberConflict(error);
    }
  }
}
