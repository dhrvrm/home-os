CREATE UNIQUE INDEX auth_sessions_token_member_idx ON auth_sessions(token_hash, member_id);

CREATE TABLE notification_preferences (
    member_id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    meal_reminders INTEGER NOT NULL DEFAULT 1 CHECK (meal_reminders IN (0, 1)),
    push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (push_enabled IN (0, 1)),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (member_id, household_id) REFERENCES members(id, household_id) ON DELETE CASCADE
);

CREATE TABLE notification_subscriptions (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_hash TEXT NOT NULL UNIQUE,
    endpoint_hash TEXT NOT NULL UNIQUE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    expiration_time INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (member_id, household_id) REFERENCES members(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (session_hash, member_id) REFERENCES auth_sessions(token_hash, member_id) ON DELETE CASCADE
);
CREATE INDEX notification_subscriptions_member_idx ON notification_subscriptions(household_id, member_id);

-- Logical reminder deduplication outlives inbox pruning. Lead times are bounded
-- to seven days, so seven-day marker retention covers the eligibility window.
CREATE TABLE notification_reminders (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    meal_id TEXT NOT NULL,
    announcement_version INTEGER NOT NULL CHECK (announcement_version > 0),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (household_id, member_id, meal_id, announcement_version),
    FOREIGN KEY (member_id, household_id) REFERENCES members(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (meal_id, household_id) REFERENCES meals(id, household_id) ON DELETE CASCADE
);
CREATE INDEX notification_reminders_expiry_idx ON notification_reminders(expires_at);

CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'meal_attendance' CHECK (kind IN ('meal_attendance')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    meal_id TEXT NOT NULL,
    announcement_version INTEGER NOT NULL CHECK (announcement_version > 0),
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY (member_id, household_id) REFERENCES members(id, household_id) ON DELETE CASCADE,
    FOREIGN KEY (meal_id, household_id) REFERENCES meals(id, household_id) ON DELETE CASCADE
);
CREATE INDEX notifications_member_time_idx ON notifications(household_id, member_id, created_at DESC, id);

CREATE TABLE notification_deliveries (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'accepted', 'failed', 'suppressed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT NOT NULL,
    claim_token TEXT,
    lease_until TEXT,
    last_status INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT,
    UNIQUE (notification_id, subscription_id)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries(state, next_attempt_at, lease_until);
