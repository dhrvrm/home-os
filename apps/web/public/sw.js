// The production build replaces this declaration with a content-versioned asset list.
const BUILD = /* HOMEOS_BUILD */ { version: "development-v3", runtimeVersion: "3.6.0-3.6.0", assets: ["/", "/manifest.webmanifest", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"] };
const CACHE_NAME = `home-os-shell-${BUILD.version}`;
const ASSISTANT_RUNTIMES = ["/vendor/wllama.wasm", "/vendor/wllama-compat.js", "/vendor/wllama-compat.wasm"];
let notificationEpoch = 0;

async function previousShellCaches() {
  return (await caches.keys()).filter((key) => key.startsWith("home-os-shell-") && key !== CACHE_NAME);
}

async function cachedAsset(cache, request) {
  const current = await cache.match(request);
  if (current) return current;
  // Immutable chunk names and versioned runtime URLs remain valid for an old
  // open tab after another tab installs an update.
  for (const key of (await previousShellCaches()).reverse()) {
    const response = await (await caches.open(key)).match(request);
    if (response) return response;
  }
  return undefined;
}

self.addEventListener("install", (event) => {
  // An incomplete new build never replaces the last usable offline shell.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(BUILD.assets)).catch(async (error) => {
    await caches.delete(CACHE_NAME);
    throw error;
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const previous = await previousShellCaches();
    // Keep one previous build for still-open clients; never remove other apps.
    await Promise.all(previous.slice(0, -1).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "HOMEOS_ACCESS_BOUNDARY") {
    notificationEpoch++;
    if (event.data.state !== "ready" && self.registration?.getNotifications) {
      event.waitUntil(self.registration.getNotifications().then((notifications) => {
        for (const notification of notifications) if (notification.tag.startsWith("home-os-reminder-")) notification.close();
      }));
    }
  }
  if (event.data?.type === "HOMEOS_ACTIVATE_UPDATE") event.waitUntil(self.skipWaiting());
  if (event.data?.type === "HOMEOS_CACHE_ASSISTANT_RUNTIME" && /^[\w.-]{1,100}$/.test(event.data.version ?? "")) {
    if (event.data.version !== BUILD.runtimeVersion) {
      event.ports?.[0]?.postMessage({ ok: false, reason: "update-required" });
      return;
    }
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        for (const path of ASSISTANT_RUNTIMES) {
          const url = `${path}?v=${encodeURIComponent(event.data.version)}`;
          const existing = await cachedAsset(cache, url);
          if (existing) await cache.put(url, existing);
          else await cache.addAll([url]);
        }
        event.ports?.[0]?.postMessage({ ok: true });
      } catch {
        event.ports?.[0]?.postMessage({ ok: false });
      }
    })());
  }
});

function notificationRecordId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function notificationDestination(value) {
  const fallback = `${self.location.origin}/?view=notifications`;
  try {
    const url = new URL(value || fallback, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== "/") return fallback;
    const mealId = url.searchParams.get("meal");
    if (url.searchParams.get("view") === "menu" && notificationRecordId(mealId)) {
      return `${self.location.origin}/?view=menu&meal=${encodeURIComponent(mealId)}`;
    }
  } catch { /* Untrusted notification locations always return to this app. */ }
  return fallback;
}

self.addEventListener("push", (event) => {
  const epoch = notificationEpoch;
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { /* A malformed push still needs a visible notification. */ }
    let title = "Home OS";
    let body = "Open Home OS to check your meal reminders.";
    let url = notificationDestination();
    const id = notificationRecordId(payload?.notificationId) ? payload.notificationId : "update";
    if (notificationRecordId(payload?.notificationId) && notificationRecordId(payload?.memberId)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await fetch(`${self.location.origin}/api/v1/notifications/${encodeURIComponent(id)}/delivery-check`, {
          credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: { "X-HomeOS-Member": payload.memberId }, signal: controller.signal,
        });
        if (response.ok) {
          const envelope = await response.json();
          const notification = envelope.error ? null : envelope.data?.notification;
          if (notification?.id === id && typeof notification.title === "string" && typeof notification.body === "string"
              && notificationRecordId(notification.mealId) && epoch === notificationEpoch) {
            title = notification.title.slice(0, 120) || title;
            body = notification.body.slice(0, 500) || body;
            url = notificationDestination(notification.url);
          }
        }
      } catch { /* Expired access or a stalled connection never reveals the old recipient's detail. */ }
      finally { clearTimeout(timeout); }
    }
    await self.registration.showNotification(title, {
      body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: `home-os-reminder-${id}`, data: { url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationDestination(event.notification.data?.url);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => client.url === url && "focus" in client);
    if (existing) await existing.focus();
    else await self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(?:api|mcp)(?:\/|$)/.test(url.pathname) || ["/healthz", "/readyz"].includes(url.pathname)) return;

  if (request.mode === "navigate") {
    // Keep HTML and the precached immutable chunks from the same app version.
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match("/")) || fetch(request)));
    return;
  }

  const staticAsset = url.pathname.startsWith("/_next/static/") || BUILD.assets.includes(url.pathname) || ASSISTANT_RUNTIMES.includes(url.pathname);
  if (!staticAsset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cachedAsset(cache, request);
    if (cached) return cached;
    if (ASSISTANT_RUNTIMES.includes(url.pathname) && url.searchParams.has("v") && url.searchParams.get("v") !== BUILD.runtimeVersion) {
      return new Response("Reload Home OS before loading the local assistant runtime.", { status: 409 });
    }
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") event.waitUntil(cache.put(request, response.clone()));
    return response;
  })());
});
