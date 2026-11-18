/** Only an explicit persisted policy may override the legacy deadline. */
export function sessionLifetimeSQL(alias: string, now = "?"): string {
  return `(${alias}.permanent = 1 OR (${alias}.permanent = 0 AND ${alias}.expires_at > ${now}))`;
}

/** Shared credential/deactivation revocation seam. U3 adds delegated grants here. */
export function revokeMemberGrants(database: D1Database, memberId: string, reason: "credentials" | "deactivated"): D1PreparedStatement[] {
  return [database.prepare(reason === "deactivated"
    ? "DELETE FROM auth_sessions WHERE member_id = ?"
    : "DELETE FROM auth_sessions WHERE member_id = ? AND credential_version < (SELECT credential_version FROM auth_accounts WHERE member_id = auth_sessions.member_id)")
    .bind(memberId)];
}
