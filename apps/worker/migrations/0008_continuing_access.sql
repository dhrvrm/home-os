-- Preserve the referenced session parent and its subscription/delivery children.
-- A legacy deadline remains metadata; permanence is always explicit.
ALTER TABLE auth_sessions ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1));
ALTER TABLE auth_sessions ADD COLUMN public_id TEXT;
UPDATE auth_sessions SET public_id = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX auth_sessions_public_id_idx ON auth_sessions(public_id);
CREATE TRIGGER auth_sessions_public_id AFTER INSERT ON auth_sessions WHEN NEW.public_id IS NULL
BEGIN
  -- Already-invalid proof must never revive if a person later rejoins or gets
  -- an account. Revocation deliberately cascades its device children.
  DELETE FROM auth_sessions WHERE token_hash = NEW.token_hash
    AND NOT EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
      WHERE m.id = NEW.member_id AND m.archived_at IS NULL
        AND a.credential_version = NEW.credential_version);
  -- Old runtimes omit the public ID. Cover their inserts during rollout too,
  -- without granting a stale, inactive, or already-expired credential access.
  UPDATE auth_sessions SET public_id = lower(hex(randomblob(16))),
    permanent = CASE WHEN NEW.permanent = 1 OR (
      NEW.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
        WHERE m.id = NEW.member_id AND m.archived_at IS NULL
          AND a.credential_version = NEW.credential_version)) THEN 1 ELSE 0 END
    WHERE token_hash = NEW.token_hash;
END;
-- Retain expired current-member history, but permanently end proof that could
-- otherwise revive after reactivation or later account creation.
DELETE FROM auth_sessions
WHERE NOT EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
  WHERE m.id = auth_sessions.member_id AND m.archived_at IS NULL
    AND a.credential_version = auth_sessions.credential_version);
UPDATE auth_sessions SET permanent = 1
WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND EXISTS (SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
    WHERE m.id = auth_sessions.member_id AND m.archived_at IS NULL
      AND a.credential_version = auth_sessions.credential_version);
