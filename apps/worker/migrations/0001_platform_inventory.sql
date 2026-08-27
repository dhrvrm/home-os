PRAGMA foreign_keys = ON;

CREATE TABLE households (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE members (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE INDEX members_household_idx ON members(household_id, archived_at);

CREATE TABLE inventory_items (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    location TEXT NOT NULL,
    unit TEXT NOT NULL,
    tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('simple', 'exact')),
    quantity REAL NOT NULL CHECK (quantity >= 0),
    stock_level TEXT NOT NULL CHECK (stock_level IN ('full', 'okay', 'low', 'out')),
    level_percent REAL NOT NULL CHECK (level_percent >= 0 AND level_percent <= 100),
    min_quantity REAL NOT NULL CHECK (min_quantity >= 0),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE INDEX inventory_items_household_updated_idx
    ON inventory_items(household_id, updated_at, id);
CREATE INDEX inventory_items_household_stock_idx
    ON inventory_items(household_id, stock_level, archived_at);
CREATE INDEX inventory_items_household_location_idx
    ON inventory_items(household_id, location, archived_at);
CREATE INDEX inventory_items_household_name_idx
    ON inventory_items(household_id, normalized_name, archived_at);

CREATE TABLE inventory_alternative_names (
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (item_id, normalized_name),
    UNIQUE (item_id, position)
);

CREATE INDEX inventory_alternative_names_search_idx
    ON inventory_alternative_names(normalized_name, item_id);

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (household_id, normalized_name)
);

CREATE TABLE inventory_item_categories (
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (item_id, category_id),
    UNIQUE (item_id, position)
);

CREATE INDEX inventory_item_categories_category_idx
    ON inventory_item_categories(category_id, item_id);

CREATE TABLE inventory_stock_events (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('consume', 'restock', 'mark_level')),
    quantity REAL NOT NULL CHECK (quantity >= 0),
    stock_level TEXT CHECK (stock_level IS NULL OR stock_level IN ('full', 'okay', 'low', 'out')),
    level_percent REAL NOT NULL CHECK (level_percent >= 0 AND level_percent <= 100),
    note TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX inventory_stock_events_item_time_idx
    ON inventory_stock_events(household_id, item_id, occurred_at, id);

CREATE TABLE processed_operations (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (household_id, operation_id)
);

CREATE INDEX processed_operations_time_idx
    ON processed_operations(household_id, processed_at);

CREATE TABLE audit_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'mcp', 'automation', 'import')),
    source TEXT NOT NULL CHECK (source IN ('pwa', 'mcp', 'automation', 'import')),
    device_id TEXT,
    operation_id TEXT NOT NULL,
    client_time TEXT,
    server_time TEXT NOT NULL,
    changes_json TEXT NOT NULL,
    mcp_client_id TEXT,
    mcp_tool TEXT,
    UNIQUE (household_id, operation_id)
);

CREATE INDEX audit_events_household_sequence_idx
    ON audit_events(household_id, sequence);
CREATE INDEX audit_events_entity_sequence_idx
    ON audit_events(household_id, entity_type, entity_id, sequence);
CREATE INDEX audit_events_actor_sequence_idx
    ON audit_events(household_id, actor_id, sequence);

INSERT INTO households (id, name, timezone, created_at, updated_at)
VALUES ('home', 'Home', 'Asia/Kolkata', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO members (id, household_id, display_name, role, created_at, updated_at)
VALUES ('local-owner', 'home', 'Home owner', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
