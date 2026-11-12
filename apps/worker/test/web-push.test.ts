import { describe, expect, it, vi } from "vitest";
import { validateNativeSubscription } from "../src/notifications/validation";
import {
  buildMealPushRequest,
  PUSH_TIMEOUT_MS,
  sendMealPush,
} from "../src/notifications/push";
import { decode64, pushFixture } from "./notification-fixtures";

const message = {
  notificationId: "notice-test",
  memberId: "local-owner",
  mealId: "notice-meal",
  url: "/?view=menu&meal=notice-meal",
};
const encoder = new TextEncoder();
function join(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    arrays.reduce((sum, item) => sum + item.length, 0),
  );
  let offset = 0;
  for (const item of arrays) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}
async function hkdf(
  input: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
) {
  const key = await crypto.subtle.importKey("raw", input, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info },
      key,
      length * 8,
    ),
  );
}

describe("encrypted native browser push", () => {
  it("independently decrypts RFC8291 content and verifies signed VAPID audience and expiry", async () => {
    const fixture = await pushFixture();
    const now = new Date().toISOString();
    const request = await buildMealPushRequest(
      fixture.settings,
      fixture.subscription,
      message,
      now,
      new Date(Date.parse(now) + 120_000).toISOString(),
    );
    expect(request.redirect).toBe("error");
    expect(new Headers(request.headers).get("TTL")).toBe("120");
    expect(new Headers(request.headers).get("Content-Encoding")).toBe(
      "aes128gcm",
    );
    const body = new Uint8Array(await new Response(request.body).arrayBuffer());
    expect(body.byteLength).toBe(4096);
    const salt = body.slice(0, 16);
    const serverKey = body.slice(21, 21 + body[20]!);
    const peer = await crypto.subtle.importKey(
      "raw",
      serverKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: peer },
        fixture.receiver.privateKey,
        256,
      ),
    );
    const ikm = await hkdf(
      secret,
      fixture.auth,
      join(encoder.encode("WebPush: info\0"), fixture.publicBytes, serverKey),
      32,
    );
    const key = await hkdf(
      ikm,
      salt,
      encoder.encode("Content-Encoding: aes128gcm\0"),
      16,
    );
    const nonce = await hkdf(
      ikm,
      salt,
      encoder.encode("Content-Encoding: nonce\0"),
      12,
    );
    const cek = await crypto.subtle.importKey("raw", key, "AES-GCM", false, [
      "decrypt",
    ]);
    const clear = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        cek,
        body.slice(21 + body[20]!),
      ),
    );
    let end = clear.length - 1;
    while (clear[end] === 0) end--;
    expect(clear[end]).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(clear.slice(0, end)))).toEqual(
      message,
    );
    const authorization = new Headers(request.headers).get("Authorization")!;
    const jwt = authorization.match(/t=([^,\s]+)/)![1]!;
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        fixture.signing.publicKey,
        decode64(signature),
        encoder.encode(`${header}.${payload}`),
      ),
    ).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(decode64(payload)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://home.dhruvverma.dev");
    expect(claims.exp).toBeGreaterThan(Date.parse(now) / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.parse(now) / 1000 + 86_400);
    expect(new Headers(request.headers).get("Topic")).toMatch(
      /^[A-Za-z0-9_-]{1,32}$/,
    );
  });

  it("accepts real providers and rejects unsafe endpoint and malformed key inputs without reflecting secrets", async () => {
    const { subscription } = await pushFixture();
    await expect(validateNativeSubscription(subscription)).resolves.toEqual(
      subscription,
    );
    for (const endpoint of [
      "http://fcm.googleapis.com/a",
      "https://127.0.0.1/a",
      "https://fcm.googleapis.com.evil.test/a",
      "https://fcm.googleapis.com:8443/a",
      "https://user:secret@fcm.googleapis.com/a",
      "https://example.test/a",
    ]) {
      await expect(
        validateNativeSubscription({ ...subscription, endpoint }),
      ).rejects.toThrow("valid browser push subscription");
    }
    for (const keys of [
      { ...subscription.keys, auth: "private-secret" },
      { ...subscription.keys, p256dh: "B".repeat(87) },
    ]) {
      await expect(
        validateNativeSubscription({ ...subscription, keys }),
      ).rejects.toThrow("valid browser push subscription");
    }
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/test",
      "https://web.push.apple.com/test",
      "https://wns2-par02p.notify.windows.com/test",
    ]) {
      await expect(
        validateNativeSubscription({ ...subscription, endpoint }),
      ).resolves.toMatchObject({ endpoint });
    }
  });

  it("uses no redirects and classifies failures without retaining provider response bodies", async () => {
    const fixture = await pushFixture();
    const now = new Date().toISOString();
    for (const [status, kind] of [
      [201, "accepted"],
      [410, "retired"],
      [404, "retired"],
      [429, "retry"],
      [503, "retry"],
      [400, "failed"],
      [302, "failed"],
    ] as const) {
      let cancelled = false;
      const result = await sendMealPush(
        fixture.settings,
        fixture.subscription,
        message,
        now,
        new Date(Date.parse(now) + 60_000).toISOString(),
        async (_url, init) => {
          expect(init?.redirect).toBe("error");
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { status },
          );
        },
      );
      expect(result).toEqual({ kind, status });
      expect(cancelled).toBe(true);
    }
    expect(
      await sendMealPush(
        fixture.settings,
        fixture.subscription,
        message,
        now,
        new Date(Date.parse(now) + 60_000).toISOString(),
        async () => {
          throw new Error("confidential provider error");
        },
      ),
    ).toEqual({ kind: "retry", status: null });
  });

  it("aborts a timed-out provider and cancels a late response body", async () => {
    const fixture = await pushFixture();
    const now = new Date().toISOString();
    let markDispatched!: () => void;
    let resolveProvider!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const provider = new Promise<Response>((resolve) => {
      resolveProvider = resolve;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const outcome = sendMealPush(
        fixture.settings,
        fixture.subscription,
        message,
        now,
        new Date(Date.parse(now) + 60_000).toISOString(),
        async (_url, request) => {
          signal = request.signal;
          markDispatched();
          return provider;
        },
      );
      await dispatched;
      await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS);
      expect(await outcome).toEqual({ kind: "retry", status: null });
      expect(signal?.aborted).toBe(true);
      let cancelled = false;
      resolveProvider(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 201 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
