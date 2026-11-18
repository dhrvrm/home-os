import type { CommandContext } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { assertAuthority, authorizedBatch, authorityPredicate } from "./authority";
import { sessionLifetimeSQL } from "./session-policy";

export interface BrowserSessionAccess {
  id: string;
  memberId: string;
  createdAt: string;
  expiresAt: string | null;
  current: boolean;
}
const publicId = /^[a-f0-9]{32}$/;
export class SessionAccessService {
  constructor(readonly database: D1Database) {}

  async listSessions(context: CommandContext, input: { memberId?: string; limit?: number; cursor?: string } = {}): Promise<{ sessions: BrowserSessionAccess[]; nextCursor: string | null }> {
    const memberId = input.memberId ?? context.actorId;
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError("limit", "choose 1 to 50 sessions");
    if (input.cursor !== undefined && !publicId.test(input.cursor)) throw new ValidationError("cursor", "is invalid");
    const subject = { householdId: context.householdId, memberId };
    await assertAuthority(this.database, context, "sessions_list", subject);
    const admitted = authorityPredicate(context, "sessions_list", subject);
    const rows = await this.database.prepare(`SELECT s.public_id, s.member_id, s.created_at, s.expires_at, s.permanent,
      s.token_hash = ? AS current FROM auth_sessions s JOIN members m ON m.id = s.member_id JOIN auth_accounts a ON a.member_id = m.id
      WHERE m.household_id = ? AND m.id = ? AND m.archived_at IS NULL AND s.credential_version = a.credential_version
      AND ${sessionLifetimeSQL("s", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")} AND s.public_id > ? AND (${admitted.sql})
      ORDER BY s.public_id LIMIT ?`)
      .bind(context.authority?.proof.kind === "browser" ? context.authority.proof.tokenHash : "", context.householdId, memberId, input.cursor ?? "", ...admitted.values, limit + 1)
      .all<{ public_id: string; member_id: string; created_at: string; expires_at: string; permanent: number; current: number }>();
    // A concurrent rejection must never be mistaken for a successfully empty list.
    await assertAuthority(this.database, context, "sessions_list", subject);
    const page = rows.results.slice(0, limit);
    return { sessions: page.map(row => ({ id: row.public_id, memberId: row.member_id, createdAt: row.created_at, expiresAt: row.permanent === 1 ? null : row.expires_at, current: !!row.current })), nextCursor: rows.results.length > limit ? page.at(-1)!.public_id : null };
  }

  async revokeSession(context: CommandContext, id: string): Promise<{ id: string; revoked: true; current: boolean }> {
    if (!publicId.test(id)) throw new ValidationError("id", "is invalid");
    await assertAuthority(this.database, context, "sessions_revoke");
    const target = await this.database.prepare(`SELECT s.member_id, s.token_hash = ? AS current FROM auth_sessions s
      JOIN members m ON m.id = s.member_id WHERE s.public_id = ? AND m.household_id = ?`)
      .bind(context.authority?.proof.kind === "browser" ? context.authority.proof.tokenHash : "", id, context.householdId)
      .first<{ member_id: string; current: number }>();
    const subject = { householdId: context.householdId, memberId: target?.member_id ?? context.actorId };
    await authorizedBatch(this.database, context, "sessions_revoke", [
      this.database.prepare("DELETE FROM auth_sessions WHERE public_id = ? AND member_id = ?").bind(id, subject.memberId),
    ], subject);
    return { id, revoked: true, current: !!target?.current };
  }
}
