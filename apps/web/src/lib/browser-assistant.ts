export const LOCAL_MODEL = {
  name: "SmolLM2 135M Instruct",
  repo: "bartowski/SmolLM2-135M-Instruct-GGUF",
  file: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
  revision: "09816acd5d99df7be770d85ea30822623dab342c",
  quantization: "Q4_K_M",
  sizeBytes: 105_454_432,
  sha256: "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d",
} as const;

const MODEL_STORAGE_HEADROOM_BYTES = Math.max(32 * 1024 * 1024, Math.ceil(LOCAL_MODEL.sizeBytes * 0.25));
export const MODEL_STORAGE_REQUIRED_BYTES = LOCAL_MODEL.sizeBytes + MODEL_STORAGE_HEADROOM_BYTES;

export interface ModelStorageReadiness {
  canDownload: boolean;
  requiredBytes: number;
  availableBytes: number | null;
  persisted: boolean | null;
  reason: "ready" | "cached" | "insufficient-storage" | "estimate-unavailable";
}

export interface BrowserStorageManager {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

export interface AssistantProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface AssistantRuntime {
  loadModelFromUrl(
    source: string,
    options: { n_ctx: number; seed: number; useCache: boolean; signal: AbortSignal; progressCallback: (progress: { loaded: number; total: number }) => void },
  ): Promise<void>;
  createChatCompletion(options: {
    messages: Array<{ role: "system" | "user"; content: string }>;
    max_tokens: number;
    temperature: number;
    seed: number;
    response_format: { type: "json_object" };
  }): Promise<{ choices: Array<{ message: { content?: string | null } }> }>;
  isSupportWebGPU(): boolean;
  exit(): Promise<void>;
}

export type AssistantRuntimeFactory = () => Promise<AssistantRuntime>;
export type ModelCacheInspector = () => Promise<boolean>;

export class BrowserAssistant {
  private runtime: AssistantRuntime | null = null;
  private loading: Promise<void> | null = null;
  private loadController: AbortController | null = null;
  private disposed = false;
  private listeners = new Set<(progress: AssistantProgress) => void>();
  private storageReadiness: ModelStorageReadiness | null = null;
  private storagePreparation: Promise<ModelStorageReadiness> | null = null;

  constructor(
    private readonly runtimeFactory: AssistantRuntimeFactory = createWllamaRuntime,
    private readonly storageManager: BrowserStorageManager = defaultStorageManager(),
    private readonly cacheInspector: ModelCacheInspector = defaultModelCacheInspector,
  ) {}

  onProgress(listener: (progress: AssistantProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
    if (this.disposed) throw new Error("The local assistant has been closed.");
    if (this.runtime) return;
    if (this.loading) return this.loading;
    const readiness = await this.prepareStorage();
    if (!readiness.canDownload) {
      throw new Error("There is not enough browser storage for the local model. Free device space or clear site data, then retry.");
    }
    if (this.disposed) throw new Error("The local assistant has been closed.");
    if (this.runtime) return;
    if (this.loading) return this.loading;
    this.loading = this.loadOnce();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async prepareStorage(): Promise<ModelStorageReadiness> {
    if (this.disposed) throw new Error("The local assistant has been closed.");
    if (this.storageReadiness) return this.storageReadiness;
    if (this.storagePreparation) return this.storagePreparation;
    const preparation = inspectModelStorage(this.storageManager, this.cacheInspector);
    this.storagePreparation = preparation;
    try {
      const readiness = await preparation;
      if (readiness.canDownload) this.storageReadiness = readiness;
      return readiness;
    } finally {
      if (this.storagePreparation === preparation) this.storagePreparation = null;
    }
  }

  async generate(prompt: { system: string; user: string }): Promise<string> {
    await this.load();
    const response = await this.runtime!.createChatCompletion({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: 180,
      temperature: 0,
      seed: 42,
      response_format: { type: "json_object" },
    });
    const content = response.choices[0]?.message.content?.trim();
    if (!content) throw new Error("The local model returned an empty response.");
    return content;
  }

  runtimeLabel(): string {
    if (!this.runtime) return "WebGPU when available, WebAssembly fallback";
    return this.runtime.isSupportWebGPU() ? "WebGPU available" : "WebAssembly CPU";
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.loadController?.abort();
    this.loadController = null;
    const runtime = this.runtime;
    this.runtime = null;
    this.loading = null;
    this.storagePreparation = null;
    this.listeners.clear();
    if (runtime) await runtime.exit();
  }

  private async loadOnce(): Promise<void> {
    const controller = new AbortController();
    this.loadController = controller;
    const runtime = await this.runtimeFactory();
    try {
      await runtime.loadModelFromUrl(
        modelSourceURL(),
        {
          n_ctx: 4096,
          seed: 42,
          useCache: true,
          signal: controller.signal,
          progressCallback: ({ loaded, total }) => {
            const safeTotal = total > 0 ? total : LOCAL_MODEL.sizeBytes;
            const progress = { loaded, total: safeTotal, percent: Math.min(100, Math.round((loaded / safeTotal) * 100)) };
            for (const listener of this.listeners) listener(progress);
          },
        },
      );
      if (this.disposed) {
        throw new Error("The local assistant was closed while loading.");
      }
      this.runtime = runtime;
    } catch (error) {
      await runtime.exit().catch(() => undefined);
      throw error;
    } finally {
      if (this.loadController === controller) this.loadController = null;
    }
  }
}

async function createWllamaRuntime(): Promise<AssistantRuntime> {
  const { LoggerWithoutDebug, Wllama } = await import("@wllama/wllama/esm/index.js");
  const runtime = new Wllama(
    { default: "/vendor/wllama.wasm" },
    { logger: LoggerWithoutDebug, suppressNativeLog: true, allowOffline: true },
  );
  runtime.setCompat({ worker: "/vendor/wllama-compat.js", wasm: "/vendor/wllama-compat.wasm" }, "firefox_safari");
  return runtime;
}

async function inspectModelStorage(storage: BrowserStorageManager, cacheInspector: ModelCacheInspector): Promise<ModelStorageReadiness> {
  try {
    if (await cacheInspector()) {
      return {
        canDownload: true,
        requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
        availableBytes: null,
        persisted: await requestPersistence(storage),
        reason: "cached",
      };
    }
  } catch {
    // A cache inspection failure must not prevent a normal quota check and download attempt.
  }
  if (!storage.estimate) return unavailableReadiness(await requestPersistence(storage));
  let estimate: { usage?: number; quota?: number };
  try {
    estimate = await storage.estimate();
  } catch {
    return unavailableReadiness(await requestPersistence(storage));
  }
  if (!Number.isFinite(estimate.quota)) return unavailableReadiness(await requestPersistence(storage));
  const usage = Number.isFinite(estimate.usage) ? Math.max(0, estimate.usage ?? 0) : 0;
  const availableBytes = Math.max(0, (estimate.quota ?? 0) - usage);
  if (availableBytes < MODEL_STORAGE_REQUIRED_BYTES) {
    return {
      canDownload: false,
      requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
      availableBytes,
      persisted: null,
      reason: "insufficient-storage",
    };
  }

  return {
    canDownload: true,
    requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
    availableBytes,
    persisted: await requestPersistence(storage),
    reason: "ready",
  };
}

function unavailableReadiness(persisted: boolean | null): ModelStorageReadiness {
  return {
    canDownload: true,
    requiredBytes: MODEL_STORAGE_REQUIRED_BYTES,
    availableBytes: null,
    persisted,
    reason: "estimate-unavailable",
  };
}

function defaultStorageManager(): BrowserStorageManager {
  return typeof navigator === "undefined" ? {} : (navigator.storage ?? {});
}

async function requestPersistence(storage: BrowserStorageManager): Promise<boolean | null> {
  try {
    const persisted = storage.persisted ? await storage.persisted() : null;
    if (persisted !== true && storage.persist) return await storage.persist();
    return persisted;
  } catch {
    return null;
  }
}

async function defaultModelCacheInspector(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return false;
  const { ModelManager } = await import("@wllama/wllama/esm/index.js");
  const models = await new ModelManager().getModels();
  return models.some((model) => model.url === modelSourceURL());
}

function modelSourceURL(): string {
  return `https://huggingface.co/${LOCAL_MODEL.repo}/resolve/${LOCAL_MODEL.revision}/${LOCAL_MODEL.file}`;
}
