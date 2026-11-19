/** Only an explicit persisted policy may override the legacy deadline. */
export function sessionLifetimeSQL(alias: string, now = "?"): string {
  return `(${alias}.permanent = 1 OR (${alias}.permanent = 0 AND ${alias}.expires_at > ${now}))`;
}

/** Revoke only losing credential generations; a password CAS loser cannot end a winner. */
export function revokeMemberGrants(database: D1Database, memberId: string, reason: "credentials" | "deactivated"): D1PreparedStatement[] {
  return [database.prepare(reason === "deactivated"
    ? "DELETE FROM auth_sessions WHERE member_id = ?"
    : "DELETE FROM auth_sessions WHERE member_id = ? AND credential_version < (SELECT credential_version FROM auth_accounts WHERE member_id = auth_sessions.member_id)")
    .bind(memberId), database.prepare(`UPDATE mcp_connections SET status = 'revoked', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cleanup_pending = 1
      WHERE member_id = ? AND status IN ('pending', 'active') ${reason === "credentials" ? "AND credential_version < (SELECT credential_version FROM auth_accounts WHERE member_id = mcp_connections.member_id)" : ""}`).bind(memberId)];
}
