CREATE TABLE expense_rules (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL,
    cadence_unit TEXT NOT NULL CHECK (cadence_unit IN ('day', 'week', 'month', 'year')),
    cadence_interval INTEGER NOT NULL CHECK (cadence_interval >= 1),
    anchor_date TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE INDEX expense_rules_household_idx ON expense_rules(household_id, archived_at, updated_at, id);

CREATE TABLE expense_participants (
    rule_id TEXT NOT NULL REFERENCES expense_rules(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES members(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    override_kind TEXT CHECK (override_kind IS NULL OR override_kind IN ('fixed', 'percent')),
    override_value INTEGER CHECK ((override_kind IS NULL) = (override_value IS NULL)),
    PRIMARY KEY (rule_id, member_id),
    UNIQUE (rule_id, position)
);

CREATE INDEX expense_participants_member_idx ON expense_participants(member_id, rule_id);
