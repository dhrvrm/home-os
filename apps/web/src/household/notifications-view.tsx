"use client";
import { useState } from "react";
import type { AuthUser } from "@/lib/auth";
import type { WorkLease } from "@/auth/work";
import type {
  CurrentPushSubscription,
  NativePushSubscription,
  NotificationPreferences,
  PushConfiguration,
} from "./types";
import { errorMessage, householdCommand, requireIdentity } from "./api";
import { notificationsData, preferencesData } from "./validate";
import { ResourceState, useHouseholdTask, useOnline, useResource } from "./ui";
const configData = (value: unknown): value is PushConfiguration =>
  !!value &&
  typeof value === "object" &&
  "pushAvailable" in value &&
  typeof value.pushAvailable === "boolean" &&
  "publicKey" in value &&
  (value.publicKey === null || typeof value.publicKey === "string");
const subscriptionData = (
  value: unknown,
): value is { subscription: CurrentPushSubscription } =>
  !!value &&
  typeof value === "object" &&
  "subscription" in value &&
  !!value.subscription &&
  typeof value.subscription === "object" &&
  "enabled" in value.subscription &&
  typeof value.subscription.enabled === "boolean";
export function pushKey(key: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export function supportsPush(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator &&
    window.isSecureContext !== false
  );
}
export function needsInstallation(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !window.matchMedia?.("(display-mode: standalone)").matches &&
    !(navigator as Navigator & { standalone?: boolean }).standalone
  );
}
export function NotificationsView(props: {
  currentUser: AuthUser;
  onOpenMeal: (mealId: string) => void;
}) {
  return (
    <NotificationScreen
      key={`${props.currentUser.householdId}:${props.currentUser.id}:${props.currentUser.role}`}
      {...props}
    />
  );
}
function NotificationScreen({
  currentUser: user,
  onOpenMeal,
}: {
  currentUser: AuthUser;
  onOpenMeal: (mealId: string) => void;
}) {
  const inbox = useResource(
    user,
    "notifications",
    "/api/v1/notifications",
    notificationsData,
  );
  const preferences = useResource(
    user,
    "notification-preferences",
    "/api/v1/notifications/preferences",
    preferencesData,
  );
  const config = useResource(
    user,
    "notification-config",
    "/api/v1/notifications/config",
    configData,
  );
  const device = useResource(
    user,
    "notification-device",
    "/api/v1/notifications/subscriptions/current",
    subscriptionData,
  );
  const task = useHouseholdTask(user);
  const connected = useOnline();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(() =>
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission,
  );
  const prefs = preferences.copy?.data.preferences;
  const configuration = config.copy?.data;
  const available = supportsPush();
  const installation = needsInstallation();
  const enabled =
    !!device.copy &&
    !device.copy.cached &&
    device.copy.data.subscription.enabled;
  const deviceLabel =
    !connected || device.copy?.cached
      ? "Device status needs a connection"
      : permission === "denied"
        ? "Blocked by browser"
        : enabled
          ? prefs && (!prefs.pushEnabled || !prefs.mealReminders)
            ? "Registered on this device · delivery paused in preferences"
            : permission === "granted"
              ? "Enabled on this device"
              : "Registered on this device · browser permission needs confirmation"
          : installation
            ? "Install this app to enable push"
            : !available || !configuration?.pushAvailable
              ? "Unavailable"
              : "Off";
  async function perform(
    key: string,
    action: (lease: WorkLease) => Promise<unknown>,
    success: string,
    accept: () => void,
  ) {
    if (pending) return;
    setPending(key);
    setError("");
    setStatus("");
    await task(
      action,
      () => {
        setPending(null);
        setStatus(success);
        setPermission(
          typeof Notification === "undefined"
            ? "unsupported"
            : Notification.permission,
        );
        accept();
      },
      (failure) => {
        setPending(null);
        setError(errorMessage(failure));
        setPermission(
          typeof Notification === "undefined"
            ? "unsupported"
            : Notification.permission,
        );
      },
    );
  }
  async function updatePreferences(change: Partial<NotificationPreferences>) {
    if (!prefs) return;
    await perform(
      "preferences",
      () =>
        householdCommand("/notifications/preferences", "PUT", {
          ...prefs,
          ...change,
        }),
      "Reminder preferences saved.",
      () => void preferences.refresh(),
    );
  }
  function enablePush() {
    if (
      pending ||
      !connected ||
      !available ||
      !configuration?.pushAvailable ||
      !configuration.publicKey ||
      !prefs
    )
      return;
    // Permission begins synchronously in the explicit button gesture, before any network await.
    const permissionRequest =
      Notification.permission === "granted"
        ? Promise.resolve<NotificationPermission>("granted")
        : Notification.requestPermission();
    const key = configuration.publicKey;
    void perform(
      "enable",
      async (lease) => {
        const result = await permissionRequest;
        requireIdentity(user, lease);
        if (result !== "granted")
          throw new Error(
            result === "denied"
              ? "Notifications are blocked. Change notification permission in browser settings; your inbox remains available."
              : "Notification permission was not granted. You can try again when ready.",
          );
        const registration = await navigator.serviceWorker.ready;
        requireIdentity(user, lease);
        let subscription = await registration.pushManager.getSubscription();
        requireIdentity(user, lease);
        if (!subscription)
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: pushKey(key),
          });
        requireIdentity(user, lease);
        const native = subscription.toJSON();
        if (!native.endpoint || !native.keys?.p256dh || !native.keys?.auth)
          throw new Error(
            "This browser did not provide a valid subscription. Try again.",
          );
        // Native delivery secrets are sent only to registration, never to the saved-copy cache.
        const input: NativePushSubscription = {
          endpoint: native.endpoint,
          expirationTime: native.expirationTime,
          keys: { p256dh: native.keys.p256dh, auth: native.keys.auth },
        };
        await householdCommand(
          "/notifications/subscriptions/current",
          "PUT",
          input,
        );
        requireIdentity(user, lease);
        await householdCommand("/notifications/preferences", "PUT", {
          ...prefs,
          pushEnabled: true,
        });
      },
      "Push notifications enabled on this device.",
      () => {
        setPermission(Notification.permission);
        void device.refresh();
        void preferences.refresh();
      },
    );
  }
  async function disablePush() {
    await perform(
      "disable",
      async (lease) => {
        await householdCommand(
          "/notifications/subscriptions/current",
          "DELETE",
        );
        requireIdentity(user, lease);
        if (available) {
          const registration = await navigator.serviceWorker.ready;
          requireIdentity(user, lease);
          const subscription = await registration.pushManager.getSubscription();
          requireIdentity(user, lease);
          if (subscription) await subscription.unsubscribe();
        }
      },
      "Push notifications disabled on this device.",
      () => void device.refresh(),
    );
  }
  async function markRead(id: string) {
    await perform(
      id,
      () =>
        householdCommand(`/notifications/${encodeURIComponent(id)}`, "PATCH", {
          read: true,
        }),
      "Notification marked read.",
      () => void inbox.refresh(),
    );
  }
  return (
    <section className="hh-panel" aria-label="Notifications">
      <header className="hh-header">
        <div>
          <h2>Notifications</h2>
          <p>
            {inbox.copy ? `${inbox.copy.data.unreadCount} unread · ` : ""}Your
            recent household reminders.
          </p>
        </div>
      </header>
      {!connected && (
        <p className="hh-notice">
          You’re offline. Saved reminders remain readable; connect to update
          settings or mark them read.
        </p>
      )}
      <ResourceState {...inbox} retry={() => void inbox.refresh()} />
      <p role="status" className="hh-status">
        {status}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="hh-list">
        {inbox.copy?.data.notifications.map((notification) => (
          <article
            className={`hh-entry${!notification.readAt ? " hh-entry--unread" : ""}`}
            key={notification.id}
            aria-label={notification.title}
          >
            <header className="hh-entry-header">
              <h3>{notification.title}</h3>
              {!notification.readAt && <span className="hh-tag">Unread</span>}
            </header>
            <p>{notification.body}</p>
            <time className="hh-muted" dateTime={notification.createdAt}>
              {new Date(notification.createdAt).toLocaleString()}
            </time>
            <div className="hh-actions">
              <button
                className="button button--primary"
                onClick={() => onOpenMeal(notification.mealId)}
              >
                Open meal
              </button>
              {!notification.readAt && (
                <button
                  className="button button--quiet"
                  disabled={!connected || !!pending}
                  onClick={() => void markRead(notification.id)}
                >
                  {pending === notification.id ? "Saving…" : "Mark read"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {inbox.copy && !inbox.copy.data.notifications.length && (
        <p className="hh-empty">
          No recent reminders. Upcoming meal reminders will appear here.
        </p>
      )}
      <p className="hh-muted">
        The inbox keeps up to 50 reminders from the past 14 days.
      </p>
      <section
        className="hh-preferences"
        aria-labelledby="reminder-preferences"
      >
        <h3 id="reminder-preferences">Reminder preferences</h3>
        <ResourceState
          {...preferences}
          retry={() => void preferences.refresh()}
        />
        {prefs && (
          <>
            <label className="hh-check">
              <input
                type="checkbox"
                checked={prefs.mealReminders}
                disabled={!connected || !!pending}
                onChange={(event) =>
                  void updatePreferences({
                    mealReminders: event.target.checked,
                  })
                }
              />
              <span>Meal reminders (inbox and push)</span>
            </label>
            <label className="hh-check">
              <input
                type="checkbox"
                checked={prefs.pushEnabled}
                disabled={!connected || !!pending}
                onChange={(event) =>
                  void updatePreferences({ pushEnabled: event.target.checked })
                }
              />
              <span>Allow push delivery across my registered devices</span>
            </label>
          </>
        )}
        <h4>Push on this device</h4>
        <p>{deviceLabel}</p>
        <ResourceState {...config} retry={() => void config.refresh()} />
        <ResourceState {...device} retry={() => void device.refresh()} />
        {installation && (
          <p className="hh-notice">
            On iPhone or iPad, add Home OS to your Home Screen from the Share
            menu, then open the installed app to enable notifications.
          </p>
        )}
        {permission === "denied" && (
          <p className="hh-notice">
            Allow notifications in this browser’s settings to enable push. Your
            in-app inbox still works.
          </p>
        )}
        {!available && !installation && (
          <p className="hh-muted">
            This browser does not support push notifications. You can keep using
            the inbox.
          </p>
        )}
        {configuration && !configuration.pushAvailable && (
          <p className="hh-muted">
            Push delivery is unavailable for this household right now. The inbox
            remains available.
          </p>
        )}
        <div className="hh-actions">
          <button
            className="button button--primary"
            disabled={
              !connected ||
              !!pending ||
              !available ||
              installation ||
              permission === "denied" ||
              !configuration?.pushAvailable ||
              !configuration.publicKey ||
              !prefs ||
              (enabled && permission === "granted" && prefs.pushEnabled)
            }
            onClick={enablePush}
          >
            {pending === "enable" ? "Enabling…" : "Enable push notifications"}
          </button>
          <button
            className="button button--quiet"
            disabled={!connected || !!pending || !enabled}
            onClick={() => void disablePush()}
          >
            {pending === "disable" ? "Disabling…" : "Disable on this device"}
          </button>
        </div>
        <p className="hh-muted">
          Browser permission alone does not enable delivery. This device must
          also be registered to your current sign-in.
        </p>
      </section>
    </section>
  );
}
