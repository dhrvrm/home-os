import { env } from "cloudflare:workers";
import { digest } from "../src/auth/crypto";
import type { Env } from "../src/env";
import type { NativePushSubscription } from "../src/notifications/model";

export function encode64(value: ArrayBuffer | Uint8Array): string {
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(value instanceof Uint8Array ? value : value),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
}
export async function pushFixture() {
  const receiver = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", receiver.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription: NativePushSubscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
    expirationTime: null,
    keys: { p256dh: encode64(publicBytes), auth: encode64(auth) },
  };
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", signing.privateKey);
  const settings = {
    ...env,
    HOMEOS_VAPID_PUBLIC_KEY: encode64(
      await crypto.subtle.exportKey("raw", signing.publicKey),
    ),
    HOMEOS_VAPID_PRIVATE_KEY: privateJwk.d!,
    HOMEOS_VAPID_SUBJECT: "https://home.dhruvverma.dev",
  } as Env;
  return { receiver, publicBytes, auth, subscription, settings, signing };
}

export async function resetNotifications() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notification_scan_state"),
    env.DB.prepare("DELETE FROM notification_reminders"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM notification_subscriptions"),
    env.DB.prepare("DELETE FROM notification_preferences"),
    env.DB.prepare("DELETE FROM meal_attendance"),
    env.DB.prepare("DELETE FROM meals"),
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare(
      "UPDATE members SET role = 'owner', archived_at = NULL WHERE id = 'local-owner'",
    ),
    env.DB.prepare("DELETE FROM members WHERE id LIKE 'notice-%'"),
  ]);
}
export async function seedNotificationMember(
  memberId = "local-owner",
  role = "owner",
  token = "a".repeat(64),
) {
  const now = new Date().toISOString();
  const hash = await digest(token);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES (?, 'home', ?, ?, ?, ?)",
    ).bind(memberId, memberId, role, now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES (?, ?, 'fixture-verifier', ?)",
    ).bind(memberId, `${memberId}@example.test`, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, ?, 1, '2099-01-01T00:00:00.000Z', ?)",
    ).bind(hash, memberId, now),
  ]);
  return hash;
}
export async function seedNotificationMeal(now = new Date().toISOString()) {
  const cookingAt = new Date(Date.parse(now) + 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO meals (id, household_id, title, cooking_at, timezone, reminder_at, recipes_json, created_at, updated_at)
    VALUES ('notice-meal', 'home', 'Dinner', ?, 'Asia/Kolkata', ?, '[]', ?, ?)`,
  )
    .bind(cookingAt, now, now, now)
    .run();
  return {
    mealId: "notice-meal",
    announcementVersion: 1,
    memberId: "local-owner",
    title: "Dinner",
    recipeNames: ["Dal"],
    cookingAt,
    reminderAt: now,
    timezone: "Asia/Kolkata",
  };
}
