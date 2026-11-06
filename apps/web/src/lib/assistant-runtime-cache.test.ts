import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantRuntimePaths, prepareAssistantRuntimeCache } from "./assistant-runtime-cache";

afterEach(() => vi.unstubAllGlobals());

describe("optional assistant runtime cache", () => {
  it("does not ask for runtime downloads without an installed service worker", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) } });
    await expect(prepareAssistantRuntimeCache()).resolves.toBeUndefined();
  });

  it.each([false, true])("waits for the compatible active worker, including with a waiting update: %s", async (waiting) => {
    let request: { type: string; version: string } | undefined;
    let respond: ((event: { data: { ok: boolean } }) => void) | null = null;
    const close = vi.fn();
    vi.stubGlobal("MessageChannel", class {
      port1 = { set onmessage(value: (event: { data: { ok: boolean } }) => void) { respond = value; }, close };
      port2 = { close };
    });
    const postMessage = vi.fn((value) => { request = value; });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage }, waiting: waiting ? {} : null }) } });
    let ready = false;
    const preparation = prepareAssistantRuntimeCache().then(() => { ready = true; return null; }, (error: unknown) => error);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    expect(request?.type).toBe("HOMEOS_CACHE_ASSISTANT_RUNTIME");
    expect(assistantRuntimePaths.wasm).toContain("?v=");
    respond!({ data: { ok: true } });
    expect(await preparation).toBeNull();
    expect(ready).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("rejects a genuinely incompatible active runtime version", async () => {
    let respond: ((event: { data: { ok: boolean; reason: string } }) => void) | null = null;
    const close = vi.fn();
    vi.stubGlobal("MessageChannel", class {
      port1 = { set onmessage(value: (event: { data: { ok: boolean; reason: string } }) => void) { respond = value; }, close };
      port2 = { close };
    });
    const postMessage = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn().mockResolvedValue({ active: { postMessage }, waiting: {} }) } });
    const preparation = prepareAssistantRuntimeCache().then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    respond!({ data: { ok: false, reason: "update-required" } });
    expect(await preparation).toEqual(expect.objectContaining({ message: "Reload Home OS before loading the local assistant." }));
  });
});
