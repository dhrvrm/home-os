CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    location TEXT NOT NULL,
    unit TEXT NOT NULL,
    tracking_mode TEXT NOT NULL CHECK (tracking_mode IN ('simple', 'exact')),
    quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    stock_level TEXT NOT NULL CHECK (stock_level IN ('full', 'okay', 'low', 'out')),
    level_percent REAL NOT NULL DEFAULT 0 CHECK (level_percent >= 0 AND level_percent <= 100),
    min_quantity REAL NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_events (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (event_type IN ('consume', 'restock', 'mark_level')),
    quantity REAL NOT NULL DEFAULT 0,
    stock_level TEXT NOT NULL CHECK (stock_level IN ('full', 'okay', 'low', 'out')),
    level_percent REAL NOT NULL DEFAULT 0 CHECK (level_percent >= 0 AND level_percent <= 100),
    note TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_alternative_names (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    PRIMARY KEY (item_id, name)
);

CREATE TABLE IF NOT EXISTS item_categories (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    category TEXT NOT NULL,
    PRIMARY KEY (item_id, category)
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_stock_level ON items(stock_level);
CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_events_item_time ON stock_events(item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_alternative_names_lookup ON item_alternative_names(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_item_categories_lookup ON item_categories(category COLLATE NOCASE);
