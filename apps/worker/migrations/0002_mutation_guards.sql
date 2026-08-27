CREATE TABLE mutation_guards (
    household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    actual_version INTEGER NOT NULL,
    CHECK (expected_version = actual_version),
    PRIMARY KEY (household_id, operation_id)
);
