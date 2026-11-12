import { buildPushPayload, type VapidKeys } from "@block65/webcrypto-web-push";
import type { Env } from "../env";
import { HomeOSError, ValidationError } from "../platform/errors";
import type {
  MealPushMessage,
  NativePushSubscription,
  PushConfiguration,
} from "./model";
import { decodePushKey, validateNativeSubscription } from "./validation";

export const PUSH_TIMEOUT_MS = 8_000;
export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;
export type PushOutcome = {
  kind: "accepted" | "retired" | "retry" | "failed";
  status: number | null;
};

async function vapidKeys(env: Env): Promise<VapidKeys | null> {
  try {
    if (!env.HOMEOS_VAPID_PUBLIC_KEY || !env.HOMEOS_VAPID_PRIVATE_KEY)
      return null;
    const publicBytes = decodePushKey(env.HOMEOS_VAPID_PUBLIC_KEY, 65);
    decodePushKey(env.HOMEOS_VAPID_PRIVATE_KEY, 32);
    if (publicBytes[0] !== 4) return null;
    await crypto.subtle.importKey(
      "raw",
      publicBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const encode = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: encode(publicBytes.slice(1, 33)),
        y: encode(publicBytes.slice(33, 65)),
        d: env.HOMEOS_VAPID_PRIVATE_KEY,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const subject = env.HOMEOS_VAPID_SUBJECT || "https://home.dhruvverma.dev";
    const url = new URL(subject);
    if (
      !(url.protocol === "https:" || url.protocol === "mailto:") ||
      url.username ||
      url.password
    )
      return null;
    return {
      publicKey: env.HOMEOS_VAPID_PUBLIC_KEY,
      privateKey: env.HOMEOS_VAPID_PRIVATE_KEY,
      subject,
    };
  } catch {
    return null;
  }
}

export async function pushConfiguration(env: Env): Promise<PushConfiguration> {
  const vapid = await vapidKeys(env);
  return { pushAvailable: vapid !== null, publicKey: vapid?.publicKey ?? null };
}

export async function pushTopic(notificationId: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(notificationId),
    ),
  );
  return btoa(String.fromCharCode(...hash.slice(0, 24)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function buildMealPushRequest(
  env: Env,
  subscription: NativePushSubscription,
  message: MealPushMessage,
  now: string,
  cookingAt: string,
): Promise<RequestInit> {
  const vapid = await vapidKeys(env);
  if (!vapid)
    throw new HomeOSError(
      "Device notifications are not configured.",
      "push_unavailable",
      503,
    );
  const native = await validateNativeSubscription(
    subscription,
    Date.parse(now),
  );
  const ttl = Math.min(
    3600,
    Math.floor((Date.parse(cookingAt) - Date.parse(now)) / 1000),
  );
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new ValidationError(
      "notification",
      "This reminder is no longer due.",
    );
  const payload: MealPushMessage = {
    notificationId: message.notificationId,
    memberId: message.memberId,
    ...(message.mealId ? { mealId: message.mealId } : {}),
    url: message.url,
  };
  if (
    new TextEncoder().encode(JSON.stringify(payload)).length > 1024 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.notificationId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.memberId) ||
    (payload.mealId && !/^[A-Za-z0-9_-]{1,128}$/.test(payload.mealId)) ||
    payload.url !==
      `/?view=menu&meal=${encodeURIComponent(payload.mealId ?? "")}`
  ) {
    throw new ValidationError(
      "notification",
      "This reminder cannot be delivered.",
    );
  }
  return {
    ...(await buildPushPayload(
      {
        data: { ...payload },
        options: {
          ttl,
          topic: await pushTopic(payload.notificationId),
          urgency: "normal",
        },
      },
      { ...native, expirationTime: native.expirationTime ?? null },
      vapid,
    )),
    redirect: "error",
  };
}

export async function sendMealPush(
  env: Env,
  subscription: NativePushSubscription,
  message: MealPushMessage,
  now: string,
  cookingAt: string,
  fetcher: PushFetch = fetch,
): Promise<PushOutcome> {
  const request = await buildMealPushRequest(
    env,
    subscription,
    message,
    now,
    cookingAt,
  );
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The race also bounds a provider adapter that ignores AbortSignal.
    const response = await Promise.race([
      fetcher(subscription.endpoint, {
        ...request,
        signal: controller.signal,
      }).then(async (response) => {
        if (controller.signal.aborted) {
          try {
            await response.body?.cancel();
          } catch {
            /* Ignore an unused late provider body. */
          }
          throw new Error("push timeout");
        }
        return response;
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("push timeout"));
        }, PUSH_TIMEOUT_MS);
      }),
    ]);
    try {
      await response.body?.cancel();
    } catch {
      /* No provider response body is needed. */
    }
    const status = response.status;
    if (status >= 200 && status < 300) return { kind: "accepted", status };
    if (status === 404 || status === 410) return { kind: "retired", status };
    if (status === 429 || status >= 500) return { kind: "retry", status };
    return { kind: "failed", status };
  } catch {
    return { kind: "retry", status: null };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
