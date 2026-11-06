// @vitest-environment node
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

async function worker() {
  const source = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const cached = new Map<string, Response>([["/", new Response("offline shell")]]);
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi.fn(async (key: string | Request) => cached.get(typeof key === "string" ? key : new URL(key.url).pathname)?.clone()),
    put: vi.fn(async (key: string | Request, value: Response) => { cached.set(typeof key === "string" ? key : new URL(key.url).pathname, value); }),
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue(["home-os-shell-older", "home-os-shell-old", "other-app-cache"]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetcher = vi.fn().mockResolvedValue(new Response("asset"));
  const self = {
    location: { origin: "https://home-os.test" },
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
  };
  vm.runInNewContext(source, { self, caches, fetch: fetcher, URL, Response, Set });
  return { cache, caches, fetcher, self, handlers };
}

describe("PWA service worker", () => {
  it("precaches the shell without forcing a waiting update to activate", async () => {
    const { handlers, cache, self } = await worker();
    const waitUntil = vi.fn();
    handlers.get("install")!({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(cache.addAll).toHaveBeenCalledWith(expect.arrayContaining(["/", "/manifest.webmanifest", "/icons/icon-192.png"]));
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it("does not intercept private APIs, MCP, health checks, external requests, or writes", async () => {
    const { handlers } = await worker();
    for (const url of ["/api/v1/items", "/api/v1/auth/session", "/mcp", "/healthz", "/readyz", "https://external.test/model.gguf"]) {
      const respondWith = vi.fn();
      handlers.get("fetch")!({ request: { method: "GET", url: new URL(url, "https://home-os.test").href, mode: "cors" }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: { method: "POST", url: "https://home-os.test/", mode: "cors" }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("caches assistant runtimes only when used and serves them offline afterward", async () => {
    const { handlers, cache, fetcher } = await worker();
    const installed = vi.fn();
    handlers.get("install")!({ waitUntil: installed });
    await installed.mock.calls[0][0];
    expect(cache.addAll.mock.calls[0][0]).not.toEqual(expect.arrayContaining(["/vendor/wllama.wasm"]));
    for (const runtime of ["/vendor/wllama.wasm", "/vendor/wllama-compat.js", "/vendor/wllama-compat.wasm"]) {
      const firstResponse = vi.fn();
      const writes = vi.fn();
      fetcher.mockResolvedValue(new Response("cached runtime"));
      handlers.get("fetch")!({ request: { method: "GET", url: `https://home-os.test${runtime}`, mode: "cors" }, respondWith: firstResponse, waitUntil: writes });
      expect(await (await firstResponse.mock.calls[0][0]).text()).toBe("cached runtime");
      await Promise.all(writes.mock.calls.map(([promise]) => promise));
      fetcher.mockRejectedValue(new TypeError("offline"));
      const respondWith = vi.fn();
      handlers.get("fetch")!({ request: { method: "GET", url: `https://home-os.test${runtime}`, mode: "cors" }, respondWith, waitUntil: vi.fn() });
      expect(await (await respondWith.mock.calls[0][0]).text()).toBe("cached runtime");
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("opens the cached shell offline and avoids caching server errors", async () => {
    const { handlers, fetcher, cache } = await worker();
    fetcher.mockRejectedValue(new TypeError("offline"));
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: { method: "GET", url: "https://home-os.test/", mode: "navigate" }, respondWith, waitUntil: vi.fn() });
    expect(await (await respondWith.mock.calls[0][0]).text()).toBe("offline shell");

    fetcher.mockResolvedValueOnce(new Response("server failure", { status: 500 }));
    const assetResponse = vi.fn();
    handlers.get("fetch")!({ request: { method: "GET", url: "https://home-os.test/_next/static/chunks/missing.js", mode: "cors" }, respondWith: assetResponse, waitUntil: vi.fn() });
    expect((await assetResponse.mock.calls[0][0]).status).toBe(500);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("cleans only Home OS caches and activates an update only on request", async () => {
    const { handlers, caches, self } = await worker();
    const waitUntil = vi.fn();
    handlers.get("activate")!({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(caches.delete).toHaveBeenCalledWith("home-os-shell-older");
    expect(caches.delete).not.toHaveBeenCalledWith("home-os-shell-old");
    expect(caches.delete).not.toHaveBeenCalledWith("other-app-cache");
    handlers.get("message")!({ data: { type: "HOMEOS_ACTIVATE_UPDATE" }, waitUntil });
    await waitUntil.mock.calls[1][0];
    expect(self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("leaves the previous shell intact when a new install fails", async () => {
    const { handlers, cache, caches, self } = await worker();
    cache.addAll.mockRejectedValueOnce(new TypeError("network unavailable"));
    const waitUntil = vi.fn();
    handlers.get("install")!({ waitUntil });
    await expect(waitUntil.mock.calls[0][0]).rejects.toThrow("network unavailable");
    expect(caches.delete).not.toHaveBeenCalledWith("home-os-shell-old");
    expect(caches.delete).not.toHaveBeenCalledWith("other-app-cache");
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it("serves an old tab's immutable chunk from the retained previous build", async () => {
    const { handlers, cache, caches, fetcher } = await worker();
    const previous = { ...cache, match: vi.fn().mockResolvedValue(new Response("previous build chunk")) };
    caches.open.mockImplementation(async (name: string) => name === "home-os-shell-old" ? previous : cache);
    fetcher.mockRejectedValue(new TypeError("offline"));
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: { method: "GET", url: "https://home-os.test/_next/static/chunks/old-hash.js", mode: "cors" }, respondWith, waitUntil: vi.fn() });
    expect(await (await respondWith.mock.calls[0][0]).text()).toBe("previous build chunk");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("acknowledges optional runtime caching only after every versioned file is saved", async () => {
    const { handlers, cache } = await worker();
    const waitUntil = vi.fn();
    const postMessage = vi.fn();
    handlers.get("message")!({ data: { type: "HOMEOS_CACHE_ASSISTANT_RUNTIME", version: "3.6.0-3.6.0" }, ports: [{ postMessage }], waitUntil });
    expect(postMessage).not.toHaveBeenCalled();
    await waitUntil.mock.calls[0][0];
    expect(cache.addAll).toHaveBeenCalledTimes(3);
    expect(cache.addAll).toHaveBeenCalledWith(["/vendor/wllama.wasm?v=3.6.0-3.6.0"]);
    expect(postMessage).toHaveBeenCalledWith({ ok: true });
  });

  it("does not return the current binary for a missing runtime from another package version", async () => {
    const { handlers, fetcher } = await worker();
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: { method: "GET", url: "https://home-os.test/vendor/wllama.wasm?v=older-package", mode: "cors" }, respondWith, waitUntil: vi.fn() });
    expect((await respondWith.mock.calls[0][0]).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
