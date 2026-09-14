ALTER TABLE inventory_items
    ADD COLUMN restock_interval_days INTEGER
    CHECK (restock_interval_days IS NULL OR (restock_interval_days > 0 AND restock_interval_days <= 3650));
