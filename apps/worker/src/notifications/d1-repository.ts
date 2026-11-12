import type { DeviceGrant } from "../auth/session";
import { HomeOSError } from "../platform/errors";
import type { MealReminderCandidate } from "../meals/model";
import type {
  CurrentPushSubscription,
  HouseholdNotification,
  NativePushSubscription,
  NotificationPreferences,
} from "./model";

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  meal_id: string;
  announcement_version: number;
  url: string;
  created_at: string;
  read_at: string | null;
}
export interface SubscriptionRow {
  id: string;
  household_id: string;
  member_id: string;
  session_hash: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: number | null;
  created_at: string;
  session_expires_at?: string;
}
export interface DeliveryRow {
  cooking_at: string;
  reminder_at: string;
  id: string;
  notification_id: string;
  subscription_id: string;
  attempt_count: number;
  claim_token: string | null;
  member_id: string;
  meal_id: string;
  announcement_version: number;
  url: string;
  state: string;
}
function publicNotification(row: NotificationRow): HouseholdNotification {
  return {
    id: row.id,
    kind: "meal_attendance",
    title: row.title,
    body: row.body,
    mealId: row.meal_id,
    announcementVersion: row.announcement_version,
    url: row.url,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
export function nativeSubscription(
  row: SubscriptionRow,
): NativePushSubscription {
  return {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}
export const CLAIM_LEASE_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 5;

export class NotificationRepository {
  constructor(
    readonly db: D1Database,
    readonly householdId: string,
  ) {}

  async scanCursor(): Promise<string | undefined> {
    const row = await this.db
      .prepare(
        "SELECT cursor FROM notification_scan_state WHERE household_id = ?",
      )
      .bind(this.householdId)
      .first<{ cursor: string | null }>();
    return row?.cursor ?? undefined;
  }

  async saveScanCursor(cursor: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notification_scan_state (household_id, cursor) VALUES (?, ?)
      ON CONFLICT(household_id) DO UPDATE SET cursor = excluded.cursor`,
      )
      .bind(this.householdId, cursor)
      .run();
  }

  async preferences(memberId: string): Promise<NotificationPreferences> {
    const row = await this.db
      .prepare(
        "SELECT meal_reminders, push_enabled FROM notification_preferences WHERE household_id = ? AND member_id = ?",
      )
      .bind(this.householdId, memberId)
      .first<{ meal_reminders: number; push_enabled: number }>();
    return {
      mealReminders: row ? row.meal_reminders === 1 : true,
      pushEnabled: row?.push_enabled === 1,
    };
  }

  async setPreferences(
    memberId: string,
    preferences: NotificationPreferences,
    now: string,
  ): Promise<NotificationPreferences> {
    await this.db
      .prepare(
        `INSERT INTO notification_preferences (household_id, member_id, meal_reminders, push_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET meal_reminders = excluded.meal_reminders,
      push_enabled = excluded.push_enabled, updated_at = excluded.updated_at WHERE household_id = excluded.household_id`,
      )
      .bind(
        this.householdId,
        memberId,
        Number(preferences.mealReminders),
        Number(preferences.pushEnabled),
        now,
      )
      .run();
    return this.preferences(memberId);
  }

  async list(
    memberId: string,
    now: string,
  ): Promise<{ notifications: HouseholdNotification[]; unreadCount: number }> {
    const cutoff = new Date(Date.parse(now) - 14 * 86_400_000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT id, title, body, meal_id, announcement_version, url, created_at, read_at FROM notifications
      WHERE household_id = ? AND member_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .bind(this.householdId, memberId, cutoff)
      .all<NotificationRow>();
    const notifications = result.results.map(publicNotification);
    return {
      notifications,
      unreadCount: notifications.filter((notice) => !notice.readAt).length,
    };
  }

  async notification(
    memberId: string,
    id: string,
    now: string,
  ): Promise<HouseholdNotification | null> {
    const cutoff = new Date(Date.parse(now) - 14 * 86_400_000).toISOString();
    const row = await this.db
      .prepare(
        `SELECT id, title, body, meal_id, announcement_version, url, created_at, read_at FROM notifications
      WHERE household_id = ? AND member_id = ? AND id = ? AND created_at > ?`,
      )
      .bind(this.householdId, memberId, id, cutoff)
      .first<NotificationRow>();
    return row ? publicNotification(row) : null;
  }

  async markRead(
    memberId: string,
    id: string,
    now: string,
  ): Promise<HouseholdNotification | null> {
    await this.db
      .prepare(
        "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE household_id = ? AND member_id = ? AND id = ?",
      )
      .bind(now, this.householdId, memberId, id)
      .run();
    return this.notification(memberId, id, now);
  }

  async currentSubscription(
    memberId: string,
    grant: DeviceGrant,
    now: string,
  ): Promise<CurrentPushSubscription> {
    const row = await this.db
      .prepare(
        `SELECT n.id, n.created_at, n.expiration_time FROM notification_subscriptions n
      WHERE n.household_id = ? AND n.member_id = ? AND n.session_hash = ? AND (n.expiration_time IS NULL OR n.expiration_time > ?)`,
      )
      .bind(this.householdId, memberId, grant.tokenHash, Date.parse(now))
      .first<{
        id: string;
        created_at: string;
        expiration_time: number | null;
      }>();
    if (!row || grant.expiresAt <= now) return { enabled: false };
    return {
      enabled: true,
      id: row.id,
      createdAt: row.created_at,
      expiresAt:
        row.expiration_time == null
          ? grant.expiresAt
          : new Date(
              Math.min(row.expiration_time, Date.parse(grant.expiresAt)),
            ).toISOString(),
    };
  }

  async registerSubscription(
    memberId: string,
    grant: DeviceGrant,
    native: NativePushSubscription,
    endpointHash: string,
    now: string,
  ): Promise<CurrentPushSubscription> {
    const existing = await this.db
      .prepare(
        "SELECT id, session_hash, p256dh, auth FROM notification_subscriptions WHERE endpoint_hash = ?",
      )
      .bind(endpointHash)
      .first<{
        id: string;
        session_hash: string;
        p256dh: string;
        auth: string;
      }>();
    if (
      existing &&
      existing.session_hash !== grant.tokenHash &&
      (existing.p256dh !== native.keys.p256dh ||
        existing.auth !== native.keys.auth)
    ) {
      throw new HomeOSError(
        "Register this browser's current subscription again.",
        "subscription_conflict",
        409,
      );
    }
    const own = await this.db
      .prepare(
        "SELECT id FROM notification_subscriptions WHERE household_id = ? AND member_id = ? AND session_hash = ?",
      )
      .bind(this.householdId, memberId, grant.tokenHash)
      .first<{ id: string }>();
    const id = own?.id ?? crypto.randomUUID();
    // A matching browser permission may move to the newly admitted account/session.
    // The conditional delete prevents an unrelated endpoint registration taking it over.
    const result = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM notification_subscriptions WHERE endpoint_hash = ? AND session_hash != ? AND p256dh = ? AND auth = ?`,
        )
        .bind(
          endpointHash,
          grant.tokenHash,
          native.keys.p256dh,
          native.keys.auth,
        ),
      this.db
        .prepare(
          `INSERT INTO notification_subscriptions
        (id, household_id, member_id, session_hash, endpoint_hash, endpoint, p256dh, auth, expiration_time, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM auth_sessions s JOIN members m ON m.id = s.member_id JOIN auth_accounts a ON a.member_id = m.id
           WHERE s.token_hash = ? AND m.id = ? AND m.household_id = ? AND m.archived_at IS NULL AND s.expires_at > ? AND s.credential_version = a.credential_version)
        ON CONFLICT(session_hash) DO UPDATE SET endpoint_hash = excluded.endpoint_hash, endpoint = excluded.endpoint,
          p256dh = excluded.p256dh, auth = excluded.auth, expiration_time = excluded.expiration_time, updated_at = excluded.updated_at
        WHERE household_id = excluded.household_id AND member_id = excluded.member_id`,
        )
        .bind(
          id,
          this.householdId,
          memberId,
          grant.tokenHash,
          endpointHash,
          native.endpoint,
          native.keys.p256dh,
          native.keys.auth,
          native.expirationTime ?? null,
          now,
          now,
          grant.tokenHash,
          memberId,
          this.householdId,
          now,
        ),
    ]);
    if (result[1]!.meta.changes !== 1)
      throw new HomeOSError(
        "Your session has ended. Sign in again.",
        "unauthorized",
        401,
      );
    // Retain at most eight device registrations per person. Sessions themselves remain intact.
    await this.db
      .prepare(
        `DELETE FROM notification_subscriptions WHERE household_id = ? AND member_id = ? AND id IN
      (SELECT id FROM notification_subscriptions WHERE household_id = ? AND member_id = ? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET 8)`,
      )
      .bind(this.householdId, memberId, this.householdId, memberId)
      .run();
    return this.currentSubscription(memberId, grant, now);
  }

  async deleteCurrentSubscription(
    memberId: string,
    tokenHash: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM notification_subscriptions WHERE household_id = ? AND member_id = ? AND session_hash = ?",
      )
      .bind(this.householdId, memberId, tokenHash)
      .run();
  }

  async createReminder(
    id: string,
    candidate: MealReminderCandidate,
    now: string,
  ): Promise<void> {
    const url = `/?view=menu&meal=${encodeURIComponent(candidate.mealId)}`;
    const title = "Will you be joining this meal?";
    const names = candidate.recipeNames.join(", ").slice(0, 500);
    const time = new Intl.DateTimeFormat("en-IN", {
      timeZone: candidate.timezone,
      hour: "numeric",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(new Date(candidate.cookingAt));
    const body =
      `${candidate.title} · ${time}${names ? `: ${names}` : ""}. Open the menu to answer.`.slice(
        0,
        800,
      );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notifications
        (id, household_id, member_id, title, body, meal_id, announcement_version, url, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM notification_reminders WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM notification_preferences WHERE household_id = ? AND member_id = ? AND meal_reminders = 0)`,
        )
        .bind(
          id,
          this.householdId,
          candidate.memberId,
          title,
          body,
          candidate.mealId,
          candidate.announcementVersion,
          url,
          now,
          id,
          this.householdId,
          candidate.memberId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_reminders
        (id, household_id, member_id, meal_id, announcement_version, cooking_at, reminder_at, created_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?)`,
        )
        .bind(
          id,
          this.householdId,
          candidate.memberId,
          candidate.mealId,
          candidate.announcementVersion,
          candidate.cookingAt,
          candidate.reminderAt,
          now,
          new Date(Date.parse(now) + 7 * 86_400_000).toISOString(),
          id,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO notification_deliveries
        (id, notification_id, subscription_id, next_attempt_at, created_at, updated_at)
        SELECT ? || '_' || s.id, ?, s.id, ?, ?, ? FROM notification_subscriptions s
        JOIN notification_preferences p ON p.member_id = s.member_id AND p.household_id = s.household_id
        WHERE s.household_id = ? AND s.member_id = ? AND p.meal_reminders = 1 AND p.push_enabled = 1
          AND (s.expiration_time IS NULL OR s.expiration_time > ?)
          AND EXISTS (SELECT 1 FROM notifications WHERE id = ?)`,
        )
        .bind(
          id,
          id,
          now,
          now,
          now,
          this.householdId,
          candidate.memberId,
          Date.parse(now),
          id,
        ),
    ]);
  }

  async dueDeliveries(now: string, limit = 20): Promise<DeliveryRow[]> {
    const result = await this.db
      .prepare(
        `SELECT d.id, d.notification_id, d.subscription_id, d.attempt_count, d.claim_token, d.state,
      n.member_id, n.meal_id, n.announcement_version, n.url, r.cooking_at, r.reminder_at
      FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      JOIN notification_reminders r ON r.id = n.id
      WHERE n.household_id = ? AND d.attempt_count < ? AND d.next_attempt_at <= ?
        AND (d.state = 'pending' OR (d.state = 'sending' AND d.lease_until <= ?))
      ORDER BY d.next_attempt_at, d.id LIMIT ?`,
      )
      .bind(
        this.householdId,
        MAX_DELIVERY_ATTEMPTS,
        now,
        now,
        Math.min(20, limit),
      )
      .all<DeliveryRow>();
    return result.results;
  }

  async claim(
    deliveryId: string,
    now: string,
    token: string,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE notification_deliveries SET state = 'sending', claim_token = ?, lease_until = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND attempt_count < ? AND next_attempt_at <= ?
        AND (state = 'pending' OR (state = 'sending' AND lease_until <= ?))
        AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = notification_id AND n.household_id = ?)`,
      )
      .bind(
        token,
        new Date(Date.parse(now) + CLAIM_LEASE_MS).toISOString(),
        now,
        deliveryId,
        MAX_DELIVERY_ATTEMPTS,
        now,
        now,
        this.householdId,
      )
      .run();
    return result.meta.changes === 1;
  }

  async ownsClaim(id: string, token: string, now: string): Promise<boolean> {
    return (
      (await this.db
        .prepare(
          `SELECT 1 FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE d.id = ? AND d.claim_token = ? AND d.state = 'sending' AND d.lease_until > ? AND n.household_id = ?`,
        )
        .bind(id, token, now, this.householdId)
        .first()) !== null
    );
  }

  async subscription(
    id: string,
    memberId: string,
  ): Promise<SubscriptionRow | null> {
    return this.db
      .prepare(
        `SELECT s.*, a.expires_at AS session_expires_at FROM notification_subscriptions s
      JOIN auth_sessions a ON a.token_hash = s.session_hash
      WHERE s.household_id = ? AND s.member_id = ? AND s.id = ?`,
      )
      .bind(this.householdId, memberId, id)
      .first<SubscriptionRow>();
  }

  async settle(
    id: string,
    token: string,
    state: "pending" | "accepted" | "failed" | "suppressed",
    now: string,
    nextAttemptAt: string,
    status: number | null,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE notification_deliveries SET state = ?, next_attempt_at = ?, last_status = ?,
      accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END, updated_at = ?, claim_token = NULL, lease_until = NULL
      WHERE id = ? AND state = 'sending' AND claim_token = ?
        AND EXISTS (SELECT 1 FROM notifications n WHERE n.id = notification_id AND n.household_id = ?)`,
      )
      .bind(
        state,
        nextAttemptAt,
        status,
        state,
        now,
        now,
        id,
        token,
        this.householdId,
      )
      .run();
    return result.meta.changes === 1;
  }

  async retireSubscription(id: string, memberId: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM notification_subscriptions WHERE id = ? AND household_id = ? AND member_id = ?",
      )
      .bind(id, this.householdId, memberId)
      .run();
  }

  async retireClaimedSubscription(
    id: string,
    memberId: string,
    deliveryId: string,
    token: string,
    expected: SubscriptionRow,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM notification_subscriptions WHERE id = ? AND household_id = ? AND member_id = ?
      AND session_hash = ? AND endpoint = ? AND p256dh = ? AND auth = ?
      AND EXISTS (SELECT 1 FROM notification_deliveries WHERE id = ? AND subscription_id = notification_subscriptions.id
        AND state = 'sending' AND claim_token = ?)`,
      )
      .bind(
        id,
        this.householdId,
        memberId,
        expected.session_hash,
        expected.endpoint,
        expected.p256dh,
        expected.auth,
        deliveryId,
        token,
      )
      .run();
    return result.meta.changes === 1;
  }

  async prune(now: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM notifications WHERE household_id = ? AND (created_at <= ? OR id IN
        (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY created_at DESC, id DESC) AS position
          FROM notifications WHERE household_id = ?) WHERE position > 50))`,
        )
        .bind(
          this.householdId,
          new Date(Date.parse(now) - 14 * 86_400_000).toISOString(),
          this.householdId,
        ),
      this.db
        .prepare(
          "DELETE FROM notification_reminders WHERE household_id = ? AND expires_at <= ?",
        )
        .bind(this.householdId, now),
      this.db
        .prepare(
          `DELETE FROM notification_subscriptions WHERE household_id = ? AND
        ((expiration_time IS NOT NULL AND expiration_time <= ?) OR NOT EXISTS
          (SELECT 1 FROM auth_sessions s JOIN members m ON m.id = s.member_id JOIN auth_accounts a ON a.member_id = m.id
           WHERE s.token_hash = notification_subscriptions.session_hash AND s.member_id = notification_subscriptions.member_id
             AND m.household_id = notification_subscriptions.household_id AND m.archived_at IS NULL
             AND s.credential_version = a.credential_version AND s.expires_at > ?))`,
        )
        .bind(this.householdId, Date.parse(now), now),
    ]);
  }
}
