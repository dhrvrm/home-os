-- Close grants left by a predecessor that archived a member without knowing MCP.
UPDATE mcp_connections
SET status = 'revoked', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cleanup_pending = 1
WHERE status IN ('active', 'pending')
  AND member_id IN (SELECT id FROM members WHERE archived_at IS NOT NULL);

-- Membership departure remains authoritative across mixed-version writers.
CREATE TRIGGER revoke_deactivated_member_connections
AFTER UPDATE OF archived_at ON members
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  UPDATE mcp_connections
  SET status = 'revoked', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), cleanup_pending = 1
  WHERE member_id = NEW.id AND status IN ('active', 'pending');
END;
