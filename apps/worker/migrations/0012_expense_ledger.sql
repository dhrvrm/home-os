-- Additive ledger; existing recurring, household and authentication rows are untouched.
CREATE UNIQUE INDEX members_household_identity ON members(household_id, id);
CREATE UNIQUE INDEX expense_rules_household_identity ON expense_rules(household_id, id);

CREATE TABLE ledger_financial_revisions (
 household_id TEXT PRIMARY KEY REFERENCES households(id),
 revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE ledger_entries (
 household_id TEXT NOT NULL REFERENCES households(id), id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('expense','refund','payment')),
 version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('effective','void')),
 currency TEXT NOT NULL CHECK(currency IN ('INR','USD','EUR','GBP','JPY')),
 total_minor INTEGER NOT NULL CHECK(typeof(total_minor) = 'integer' AND total_minor BETWEEN 1 AND 10000000000),
 expense_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(household_id,id),
 FOREIGN KEY(household_id,expense_id) REFERENCES ledger_entries(household_id,id)
);
CREATE INDEX ledger_entries_current_currency ON ledger_entries(household_id,lifecycle,currency,id);
CREATE INDEX ledger_entries_refunds ON ledger_entries(household_id,expense_id,lifecycle,id);
CREATE TABLE ledger_revisions (
 household_id TEXT NOT NULL, entry_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
 actor_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('app','api','mcp')),
 operation_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('create','correct','void','restore','post')),
 accepted_at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(household_id,entry_id,version), UNIQUE(household_id,operation_id),
 FOREIGN KEY(household_id,entry_id) REFERENCES ledger_entries(household_id,id),
 FOREIGN KEY(household_id,actor_id) REFERENCES members(household_id,id)
);
CREATE TABLE ledger_effects (
 household_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL,
 effect_kind TEXT NOT NULL CHECK(effect_kind IN ('snapshot','reversal','replacement')),
 member_id TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('INR','USD','EUR','GBP','JPY')),
 amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor) = 'integer' AND amount_minor BETWEEN -10000000000 AND 10000000000),
 PRIMARY KEY(household_id,entry_id,version,effect_kind,member_id),
 FOREIGN KEY(household_id,entry_id,version) REFERENCES ledger_revisions(household_id,entry_id,version),
 FOREIGN KEY(household_id,member_id) REFERENCES members(household_id,id)
);
CREATE INDEX ledger_effects_member ON ledger_effects(household_id,member_id,currency,entry_id,version);
-- Original sides retain zero allocations and participant order for caps and explanation.
CREATE TABLE ledger_allocations (
 household_id TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('payer','share')), position INTEGER NOT NULL CHECK(typeof(position) = 'integer' AND position BETWEEN 0 AND 11),
 member_id TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor) = 'integer' AND amount_minor BETWEEN 0 AND 10000000000),
 PRIMARY KEY(household_id,entry_id,version,side,member_id), UNIQUE(household_id,entry_id,version,side,position),
 FOREIGN KEY(household_id,entry_id,version) REFERENCES ledger_revisions(household_id,entry_id,version),
 FOREIGN KEY(household_id,member_id) REFERENCES members(household_id,id)
);
CREATE TABLE ledger_comments (
 household_id TEXT NOT NULL, id TEXT NOT NULL, entry_id TEXT NOT NULL, observed_version INTEGER NOT NULL CHECK(typeof(observed_version) = 'integer' AND observed_version BETWEEN 1 AND 9007199254740991),
 author_id TEXT NOT NULL, operation_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000), accepted_at TEXT NOT NULL,
 PRIMARY KEY(household_id,id), UNIQUE(household_id,operation_id),
 FOREIGN KEY(household_id,entry_id,observed_version) REFERENCES ledger_revisions(household_id,entry_id,version),
 FOREIGN KEY(household_id,author_id) REFERENCES members(household_id,id)
);
CREATE INDEX ledger_comments_entry ON ledger_comments(household_id,entry_id,accepted_at,id);
CREATE TABLE ledger_sources (
 household_id TEXT NOT NULL, entry_id TEXT NOT NULL, rule_id TEXT NOT NULL,
 period_start TEXT NOT NULL, period_end TEXT NOT NULL, rule_version INTEGER NOT NULL CHECK(typeof(rule_version) = 'integer' AND rule_version BETWEEN 1 AND 9007199254740991),
 period INTEGER NOT NULL CHECK(typeof(period) = 'integer' AND period BETWEEN 0 AND 9007199254740991),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(household_id,entry_id), UNIQUE(household_id,rule_id,period_start),
 FOREIGN KEY(household_id,entry_id) REFERENCES ledger_entries(household_id,id),
 FOREIGN KEY(household_id,rule_id) REFERENCES expense_rules(household_id,id)
);
CREATE TRIGGER ledger_revisions_immutable_update BEFORE UPDATE ON ledger_revisions BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_revisions_immutable_delete BEFORE DELETE ON ledger_revisions BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_effects_immutable_update BEFORE UPDATE ON ledger_effects BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_effects_immutable_delete BEFORE DELETE ON ledger_effects BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_allocations_immutable_update BEFORE UPDATE ON ledger_allocations BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_allocations_immutable_delete BEFORE DELETE ON ledger_allocations BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_comments_immutable_update BEFORE UPDATE ON ledger_comments BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_comments_immutable_delete BEFORE DELETE ON ledger_comments BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_sources_immutable_update BEFORE UPDATE ON ledger_sources BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
CREATE TRIGGER ledger_sources_immutable_delete BEFORE DELETE ON ledger_sources BEGIN SELECT RAISE(ABORT,'immutable_ledger_history'); END;
