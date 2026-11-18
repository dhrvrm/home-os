CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  member_id TEXT NOT NULL REFERENCES members(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  credential_version INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  resource TEXT NOT NULL,
  approved_role TEXT NOT NULL CHECK (approved_role IN ('owner','member','viewer')),
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked','failed')),
  provider_grant_id TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  established_at TEXT,
  exchange_until TEXT NOT NULL,
  ended_at TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0,1))
);
CREATE INDEX mcp_connections_member ON mcp_connections(household_id, member_id, id);
CREATE INDEX mcp_connections_cleanup ON mcp_connections(cleanup_pending, id);
CREATE UNIQUE INDEX mcp_connections_grant ON mcp_connections(provider_grant_id) WHERE provider_grant_id IS NOT NULL;
CREATE TABLE mcp_consent_intents (
  id TEXT PRIMARY KEY CHECK (length(id) = 32),
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','failed')),
  reviewed_member_id TEXT,
  reviewed_role TEXT,
  reviewed_credential_version INTEGER,
  reviewed_session_hash TEXT,
  consent_handle TEXT
);
CREATE INDEX mcp_consent_expiry ON mcp_consent_intents(expires_at);
-- A fixed number of global ingress buckets bounds anonymous persistent cardinality.
CREATE TABLE oauth_admission (
  flow TEXT PRIMARY KEY CHECK (flow IN ('register','authorize')),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
-- Reserve capacity before anonymous provider writes. Uncertain failures retain their slot.
CREATE TABLE oauth_registrations (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  cleanup_nonce TEXT,
  cleanup_started_at TEXT
);
CREATE TABLE oauth_client_sweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  started_at TEXT
);
INSERT INTO oauth_client_sweep (id) VALUES (1);
-- A role change invalidates a preview even if the role later returns to its old value.
CREATE TRIGGER invalidate_role_consent_preview
AFTER UPDATE OF role ON members WHEN OLD.role <> NEW.role
BEGIN
  UPDATE mcp_consent_intents SET reviewed_role = NULL, consent_handle = NULL
    WHERE reviewed_member_id = NEW.id AND status = 'pending';
END;
