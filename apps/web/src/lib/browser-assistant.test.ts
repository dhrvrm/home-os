import { describe, expect, it, vi } from "vitest";
import {
  BrowserAssistant,
  LOCAL_MODEL,
  MODEL_STORAGE_REQUIRED_BYTES,
  type AssistantRuntime,
  type BrowserStorageManager,
} from "./browser-assistant";

function fakeRuntime(overrides: Partial<AssistantRuntime> = {}): AssistantRuntime {
  return {
    loadModelFromUrl: vi.fn(async (_source, options) => options.progressCallback({ loaded: LOCAL_MODEL.sizeBytes, total: LOCAL_MODEL.sizeBytes })),
    createChatCompletion: vi.fn(async () => ({ choices: [{ message: { content: '{"intent":"help"}' } }] })),
    isSupportWebGPU: vi.fn(() => true),
    exit: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("BrowserAssistant", () => {
  it("estimates model capacity and requests persistent storage after preparation", async () => {
    const storage: BrowserStorageManager = {
      estimate: vi.fn(async () => ({ usage: 10_000_000, quota: 500_000_000 })),
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => true),
    };
    const assistant = new BrowserAssistant(async () => fakeRuntime(), storage);

    expect(storage.estimate).not.toHaveBeenCalled();
    const readiness = await assistant.prepareStorage();
    expect(readiness).toEqual({
      canDownload: true,
      requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
      availableBytes: 490_000_000,
      persisted: true,
      reason: "ready",
    });
    expect(storage.persist).toHaveBeenCalledOnce();
  });

  it("fails before runtime creation when known storage is insufficient", async () => {
    const factory = vi.fn(async () => fakeRuntime());
    const storage: BrowserStorageManager = {
      estimate: vi.fn(async () => ({ usage: 90_000_000, quota: 100_000_000 })),
      persist: vi.fn(async () => true),
    };
    const assistant = new BrowserAssistant(factory, storage);
    await expect(assistant.prepareStorage()).resolves.toMatchObject({
      canDownload: false, availableBytes: 10_000_000, reason: "insufficient-storage",
    });
    await expect(assistant.load()).rejects.toThrow("not enough browser storage");
    expect(factory).not.toHaveBeenCalled();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("loads an already cached model even when first-download capacity is unavailable", async () => {
    const runtime = fakeRuntime();
    const factory = vi.fn(async () => runtime);
    const assistant = new BrowserAssistant(factory, {
      estimate: vi.fn(async () => ({ usage: 90_000_000, quota: 100_000_000 })),
      persisted: vi.fn(async () => true),
    }, async () => true);

    await expect(assistant.prepareStorage()).resolves.toMatchObject({ canDownload: true, reason: "cached", persisted: true });
    await assistant.load();
    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.loadModelFromUrl).toHaveBeenCalledOnce();
  });

  it("allows a recoverable attempt when storage estimation is unavailable", async () => {
    const missing = new BrowserAssistant(async () => fakeRuntime(), {});
    await expect(missing.prepareStorage()).resolves.toEqual({
      canDownload: true,
      requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
      availableBytes: null,
      persisted: null,
      reason: "estimate-unavailable",
    });

    const rejected = new BrowserAssistant(async () => fakeRuntime(), {
      estimate: vi.fn(async () => { throw new Error("estimate blocked"); }),
    });
    await expect(rejected.prepareStorage()).resolves.toMatchObject({ canDownload: true, reason: "estimate-unavailable" });
  });

  it("does not request persistence when browser storage is already persistent", async () => {
    const storage: BrowserStorageManager = {
      estimate: vi.fn(async () => ({ usage: 0, quota: 500_000_000 })),
      persisted: vi.fn(async () => true),
      persist: vi.fn(async () => true),
    };
    const assistant = new BrowserAssistant(async () => fakeRuntime(), storage);
    await assistant.prepareStorage();
    await assistant.prepareStorage();
    expect(storage.estimate).toHaveBeenCalledOnce();
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("loads once, reports progress, and reuses the runtime", async () => {
    const runtime = fakeRuntime();
    const factory = vi.fn(async () => runtime);
    const assistant = new BrowserAssistant(factory);
    const progress = vi.fn();
    assistant.onProgress(progress);

    await Promise.all([assistant.load(), assistant.load()]);
    const output = await assistant.generate({ system: "system", user: "user" });

    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.loadModelFromUrl).toHaveBeenCalledWith(expect.stringContaining(LOCAL_MODEL.revision), expect.any(Object));
    expect(runtime.loadModelFromUrl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ n_ctx: 4096 }));
    expect(progress).toHaveBeenCalledWith({ loaded: LOCAL_MODEL.sizeBytes, total: LOCAL_MODEL.sizeBytes, percent: 100 });
    expect(output).toBe('{"intent":"help"}');
    expect(assistant.runtimeLabel()).toContain("WebGPU");
  });

  it("propagates generation errors and rejects empty output", async () => {
    const failed = new BrowserAssistant(async () => fakeRuntime({ createChatCompletion: vi.fn(async () => { throw new Error("inference failed"); }) }));
    await expect(failed.generate({ system: "s", user: "u" })).rejects.toThrow("inference failed");

    const empty = new BrowserAssistant(async () => fakeRuntime({ createChatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "" } }] })) }));
    await expect(empty.generate({ system: "s", user: "u" })).rejects.toThrow("empty response");
  });

  it("cleans up a failed load and can dispose a loaded runtime", async () => {
    const loadError = new Error("download failed");
    const failing = fakeRuntime({ loadModelFromUrl: vi.fn(async () => { throw loadError; }) });
    const assistant = new BrowserAssistant(async () => failing);
    await expect(assistant.load()).rejects.toThrow("download failed");
    expect(failing.exit).toHaveBeenCalledOnce();

    const loaded = fakeRuntime();
    const ready = new BrowserAssistant(async () => loaded);
    await ready.load();
    await ready.dispose();
    expect(loaded.exit).toHaveBeenCalledOnce();
  });

  it("aborts and cleans up a load that races with disposal", async () => {
    const loading = fakeRuntime({
      loadModelFromUrl: vi.fn((_source, options) => new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })),
    });
    const assistant = new BrowserAssistant(async () => loading);
    await assistant.prepareStorage();
    const load = assistant.load();
    await vi.waitFor(() => expect(loading.loadModelFromUrl).toHaveBeenCalledOnce());
    await assistant.dispose();
    await expect(load).rejects.toThrow("Aborted");
    expect(loading.exit).toHaveBeenCalledOnce();
    await expect(assistant.load()).rejects.toThrow("closed");
  });
});
