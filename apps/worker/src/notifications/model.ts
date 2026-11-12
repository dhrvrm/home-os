/** Public notification DTOs: never add endpoints, encryption keys, or session hashes. */
export interface HouseholdNotification {
  id: string;
  kind: "meal_attendance";
  title: string;
  body: string;
  mealId: string;
  announcementVersion: number;
  url: string;
  createdAt: string;
  readAt: string | null;
}
export type NotificationRecord = HouseholdNotification;

export interface NotificationPreferences {
  mealReminders: boolean;
  pushEnabled: boolean;
}

export interface PushConfiguration {
  pushAvailable: boolean;
  publicKey: string | null;
}

export interface CurrentPushSubscription {
  enabled: boolean;
  id?: string;
  createdAt?: string;
  expiresAt?: string | null;
}

export interface NativePushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** Payloads identify the intended recipient; the worker obtains a fresh preview. */
export interface MealPushMessage {
  notificationId: string;
  memberId: string;
  mealId?: string;
  url: string;
}
