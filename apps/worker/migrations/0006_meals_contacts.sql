-- Preserve existing household/member identities while making household ownership
-- enforceable in references from the new domains.
CREATE UNIQUE INDEX members_id_household_idx ON members(id, household_id);

CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    servings INTEGER NOT NULL CHECK (servings BETWEEN 1 AND 100),
    ingredients_json TEXT NOT NULL CHECK (json_valid(ingredients_json)),
    instructions TEXT NOT NULL DEFAULT '',
    labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (id, household_id)
);
CREATE INDEX recipes_household_idx ON recipes(household_id, archived_at, name, id);

CREATE TABLE meals (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    cooking_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    reminder_minutes_before INTEGER NOT NULL DEFAULT 60 CHECK (reminder_minutes_before BETWEEN 1 AND 10080),
    reminder_at TEXT NOT NULL CHECK (reminder_at < cooking_at),
    notes TEXT NOT NULL DEFAULT '',
    recipes_json TEXT NOT NULL CHECK (json_valid(recipes_json)),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    announcement_version INTEGER NOT NULL DEFAULT 1 CHECK (announcement_version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, household_id)
);
CREATE INDEX meals_household_cooking_idx ON meals(household_id, cooking_at, id);
CREATE INDEX meals_reminder_idx ON meals(household_id, status, reminder_at, cooking_at);

-- A response has its own version and retains the announcement it answered.
-- The command audit preserves accepted prior responses when this row changes.
CREATE TABLE meal_attendance (
    meal_id TEXT NOT NULL,
    household_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    response TEXT NOT NULL CHECK (response IN ('yes', 'no', 'pending')),
    announcement_version INTEGER NOT NULL CHECK (announcement_version > 0),
    response_version INTEGER NOT NULL DEFAULT 1 CHECK (response_version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meal_id, member_id),
    FOREIGN KEY (meal_id, household_id) REFERENCES meals(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (member_id, household_id) REFERENCES members(id, household_id) ON DELETE CASCADE
);
CREATE INDEX meal_attendance_household_idx ON meal_attendance(household_id, member_id, meal_id);

CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json)),
    notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);
CREATE INDEX contacts_household_idx ON contacts(household_id, archived_at, name, id);

-- New-domain operation receipts include enough identity to reject an operation
-- ID reused for a different actor, command, target, or payload.
CREATE TABLE household_command_receipts (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (household_id, operation_id)
);
CREATE INDEX household_command_receipts_time_idx ON household_command_receipts(household_id, created_at);
