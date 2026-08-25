import { describe, expect, it, vi } from "vitest";
import { BrowserAssistant, LOCAL_MODEL, type AssistantRuntime } from "./browser-assistant";

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
    const load = assistant.load();
    await Promise.resolve();
    await assistant.dispose();
    await expect(load).rejects.toThrow("Aborted");
    expect(loading.exit).toHaveBeenCalledOnce();
    await expect(assistant.load()).rejects.toThrow("closed");
  });
});
