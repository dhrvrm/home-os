// The production build replaces this declaration with a content-versioned asset list.
const BUILD = /* HOMEOS_BUILD */ { version: "development-v3", runtimeVersion: "3.6.0-3.6.0", assets: ["/", "/manifest.webmanifest", "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"] };
const CACHE_NAME = `home-os-shell-${BUILD.version}`;
const ASSISTANT_RUNTIMES = ["/vendor/wllama.wasm", "/vendor/wllama-compat.js", "/vendor/wllama-compat.wasm"];

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
