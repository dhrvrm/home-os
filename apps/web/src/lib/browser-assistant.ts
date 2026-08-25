export const LOCAL_MODEL = {
  name: "SmolLM2 135M Instruct",
  repo: "bartowski/SmolLM2-135M-Instruct-GGUF",
  file: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
  revision: "09816acd5d99df7be770d85ea30822623dab342c",
  quantization: "Q4_K_M",
  sizeBytes: 105_454_432,
  sha256: "2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d",
} as const;

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

export class BrowserAssistant {
  private runtime: AssistantRuntime | null = null;
  private loading: Promise<void> | null = null;
  private loadController: AbortController | null = null;
  private disposed = false;
  private listeners = new Set<(progress: AssistantProgress) => void>();

  constructor(private readonly runtimeFactory: AssistantRuntimeFactory = createWllamaRuntime) {}

  onProgress(listener: (progress: AssistantProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
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
    this.listeners.clear();
    if (runtime) await runtime.exit();
  }

  private async loadOnce(): Promise<void> {
    const controller = new AbortController();
    this.loadController = controller;
    const runtime = await this.runtimeFactory();
    try {
      await runtime.loadModelFromUrl(
        `https://huggingface.co/${LOCAL_MODEL.repo}/resolve/${LOCAL_MODEL.revision}/${LOCAL_MODEL.file}`,
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
  const runtime = new Wllama({ default: "/vendor/wllama.wasm" }, { logger: LoggerWithoutDebug, suppressNativeLog: true });
  runtime.setCompat({ worker: "/vendor/wllama-compat.js", wasm: "/vendor/wllama-compat.wasm" }, "firefox_safari");
  return runtime;
}
