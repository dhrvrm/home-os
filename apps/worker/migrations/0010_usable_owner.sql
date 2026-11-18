-- An owner without a login cannot keep household access manageable.
-- The initial owner has no account until bootstrap, so only established access
-- participates in this protection.
DROP TRIGGER IF EXISTS keep_last_active_owner;
CREATE TRIGGER keep_last_active_owner
BEFORE UPDATE OF role, archived_at ON members
WHEN OLD.role = 'owner' AND OLD.archived_at IS NULL
 AND EXISTS (SELECT 1 FROM auth_accounts WHERE member_id = OLD.id)
 AND (NEW.role <> 'owner' OR NEW.archived_at IS NOT NULL)
 AND NOT EXISTS (
   SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
   WHERE m.household_id = OLD.household_id AND m.id <> OLD.id
     AND m.role = 'owner' AND m.archived_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner');
END;
