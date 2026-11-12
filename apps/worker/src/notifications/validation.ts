import { z } from "zod";
import { ValidationError } from "../platform/errors";
import type { NativePushSubscription, NotificationPreferences } from "./model";

const preferencesSchema = z
  .object({ mealReminders: z.boolean(), pushEnabled: z.boolean() })
  .strict();
const nativeSchema = z
  .object({
    endpoint: z.string().min(1).max(4096),
    expirationTime: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(100),
        auth: z.string().min(1).max(32),
      })
      .strict(),
  })
  .strict();

export function parsePreferences(value: unknown): NotificationPreferences {
  const parsed = preferencesSchema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError(
      "preferences",
      "Choose both meal reminder and push preferences.",
    );
  return parsed.data;
}

export function parseRead(value: unknown): void {
  if (
    !z
      .object({ read: z.literal(true) })
      .strict()
      .safeParse(value).success
  ) {
    throw new ValidationError(
      "read",
      "Set read to true to acknowledge this reminder.",
    );
  }
}

export function notificationId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new ValidationError("id", "Choose a valid notification.");
  return value;
}

export function decodePushKey(
  value: string,
  expectedLength: number,
): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error("invalid key");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
  if (bytes.length !== expectedLength) throw new Error("invalid key");
  return bytes;
}

export async function validateNativeSubscription(
  value: unknown,
  now = Date.now(),
): Promise<NativePushSubscription> {
  try {
    const native = nativeSchema.parse(value);
    const endpoint = new URL(native.endpoint);
    const host = endpoint.hostname;
    const browserHost =
      host === "fcm.googleapis.com" ||
      /^(?:[a-z0-9-]+\.)?push\.services\.mozilla\.com$/.test(host) ||
      /^(?:[a-z0-9-]+\.)?push\.apple\.com$/.test(host) ||
      /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
    if (
      !browserHost ||
      endpoint.protocol !== "https:" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw new Error("invalid endpoint");
    // Check the original authority too: URL normalizes an explicitly supplied default port.
    const authority = native.endpoint.match(/^https:\/\/([^/\?#]+)/i)?.[1];
    if (!authority || authority.includes(":"))
      throw new Error("invalid endpoint");
    if (native.expirationTime != null && native.expirationTime <= now)
      throw new Error("expired subscription");
    const point = decodePushKey(native.keys.p256dh, 65);
    if (point[0] !== 4) throw new Error("invalid key");
    await crypto.subtle.importKey(
      "raw",
      point,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    decodePushKey(native.keys.auth, 16);
    return native;
  } catch {
    // Neither Zod's input nor provider endpoints/keys belong in an API error.
    throw new ValidationError(
      "subscription",
      "Provide a valid browser push subscription.",
    );
  }
}
