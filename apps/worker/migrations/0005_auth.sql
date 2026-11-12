CREATE TABLE auth_bootstrap (
    household_id TEXT PRIMARY KEY REFERENCES households(id),
    created_at TEXT NOT NULL
);

CREATE TABLE auth_accounts (
    member_id TEXT PRIMARY KEY REFERENCES members(id),
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    credential_version INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_member_idx ON auth_sessions(member_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE auth_attempts (
    attempt_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);

CREATE INDEX auth_attempts_window_idx ON auth_attempts(window_start);

CREATE TRIGGER keep_last_active_owner
BEFORE UPDATE OF role, archived_at ON members
WHEN OLD.role = 'owner' AND OLD.archived_at IS NULL
 AND (NEW.role <> 'owner' OR NEW.archived_at IS NOT NULL)
 AND (SELECT COUNT(*) FROM members WHERE household_id = OLD.household_id
      AND role = 'owner' AND archived_at IS NULL) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner');
END;
