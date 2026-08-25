"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight, Check, Cpu, HardDrive, LockKey, Sparkle, WarningCircle, X } from "@phosphor-icons/react";
import { BrowserAssistant, LOCAL_MODEL, type AssistantProgress } from "@/lib/browser-assistant";
import {
  buildAssistantPrompt,
  parseModelCommand,
  proposalInput,
  runDeterministicQuery,
  type AssistantProposal,
  type AssistantResult,
} from "@/lib/inventory-assistant";
import type { InventoryItem } from "@/lib/inventory";

interface InventoryAssistantProps {
  assistant: BrowserAssistant;
  items: InventoryItem[];
  onApply: (proposal: AssistantProposal) => Promise<void>;
  onClose: () => void;
}

type ModelState = "idle" | "loading" | "ready" | "thinking" | "error";

const SUGGESTIONS = [
  "What is running low?",
  "Where is rice?",
  "Add Kitchen to Rice categories",
];

export function InventoryAssistant({ assistant, items, onApply, onClose }: InventoryAssistantProps) {
  const [modelState, setModelState] = useState<ModelState>("idle");
  const [progress, setProgress] = useState<AssistantProgress | null>(null);
  const [request, setRequest] = useState("");
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => assistant.onProgress(setProgress), [assistant]);
  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    return () => returnFocus?.focus();
  }, []);

  function handleDialogKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !applying && modelState !== "thinking") {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("*") ?? []).filter((element) => (
      element.matches('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function ask(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setRequest(trimmed);
    setResult(null);
    setError(null);
    setApplied(false);
    const local = runDeterministicQuery(trimmed, items);
    if (local) {
      setPendingRequest(null);
      setResult(local);
      return;
    }
    if (modelState !== "ready") {
      setPendingRequest(trimmed);
      return;
    }
    await generate(trimmed);
  }

  async function enableModel() {
    setModelState("loading");
    setError(null);
    try {
      await assistant.load();
      setModelState("ready");
      if (pendingRequest) await generate(pendingRequest);
    } catch (cause) {
      setModelState("error");
      setError(messageFor(cause, "The local model could not be loaded. Check storage space and your connection, then retry."));
    }
  }

  async function generate(value: string) {
    setModelState("thinking");
    setPendingRequest(null);
    setError(null);
    try {
      const output = await assistant.generate(buildAssistantPrompt(value, items));
      setResult(parseModelCommand(output, items));
      setModelState("ready");
    } catch (cause) {
      setModelState("ready");
      setError(messageFor(cause, "The local model could not finish that request."));
    }
  }

  async function apply(proposal: AssistantProposal) {
    setApplying(true);
    setError(null);
    try {
      await onApply({ ...proposal, changes: proposalInput(proposal) });
      setApplied(true);
      setResult(null);
    } catch (cause) {
      setError(messageFor(cause, "The proposed change could not be saved."));
    } finally {
      setApplying(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(request);
  }

  const busy = modelState === "loading" || modelState === "thinking" || applying;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={dialogRef} className="dialog assistant-dialog" role="dialog" aria-modal="true" aria-labelledby="assistant-title" onKeyDown={handleDialogKeys}>
        <header className="dialog__header assistant-dialog__header">
          <div>
            <p className="dialog__context">Private inventory assistant</p>
            <h2 id="assistant-title"><Sparkle size={21} weight="fill" aria-hidden="true" /> Ask Home</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close assistant" disabled={busy}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        <div className="assistant-dialog__body">
          <div className="assistant-privacy">
            <LockKey size={20} weight="duotone" aria-hidden="true" />
            <p><strong>No hosted AI receives your inventory.</strong><span>Simple questions run instantly. The optional model downloads once and runs in this browser.</span></p>
          </div>

          <form className="assistant-prompt" onSubmit={submit}>
            <label htmlFor="assistant-request">Ask about inventory or propose an edit</label>
            <div>
              <input
                id="assistant-request"
                autoFocus
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                maxLength={280}
                placeholder="What is running low?"
                disabled={busy}
              />
              <button className="button button--primary" type="submit" disabled={busy || !request.trim()} aria-label="Ask Home">
                <ArrowRight size={18} weight="bold" aria-hidden="true" />
              </button>
            </div>
          </form>

          <div className="assistant-suggestions" aria-label="Suggested questions">
            {SUGGESTIONS.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => void ask(suggestion)} disabled={busy}>{suggestion}</button>
            ))}
          </div>

          {pendingRequest && (modelState === "idle" || modelState === "error") && (
            <section className="model-consent" aria-labelledby="model-consent-title">
              <div className="model-consent__icon"><Cpu size={23} weight="duotone" aria-hidden="true" /></div>
              <div>
                <h3 id="model-consent-title">This request needs the local model</h3>
                <p>Download {LOCAL_MODEL.name} ({formatBytes(LOCAL_MODEL.sizeBytes)}). It is cached on this device; no hosted AI service receives your inventory.</p>
                <dl>
                  <div><dt>Runtime</dt><dd>WebGPU / WASM</dd></div>
                  <div><dt>Model</dt><dd>{LOCAL_MODEL.quantization}</dd></div>
                </dl>
                <button className="button button--primary" type="button" onClick={() => void enableModel()}>{modelState === "error" ? "Retry local assistant" : "Enable local assistant"}</button>
              </div>
            </section>
          )}

          {modelState === "loading" && (
            <section className="model-loading" aria-live="polite">
              <div><HardDrive size={20} weight="duotone" aria-hidden="true" /><strong>Preparing local model</strong><span>{progress ? `${progress.percent}%` : "Starting…"}</span></div>
              <progress max="100" value={progress?.percent ?? 0}>Model download {progress?.percent ?? 0}%</progress>
              <p>{progress ? `${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}` : "Checking the browser cache"}</p>
            </section>
          )}

          {modelState === "thinking" && <p className="assistant-thinking" aria-live="polite"><Sparkle size={17} weight="fill" aria-hidden="true" /> Interpreting this request on your device…</p>}

          {result && <AssistantResultView result={result} applying={applying} onApply={apply} onCancel={() => setResult(null)} />}

          {applied && <p className="assistant-success" role="status"><Check size={18} weight="bold" aria-hidden="true" /> Inventory updated after your confirmation.</p>}
          {error && <p className="assistant-error" role="alert"><WarningCircle size={19} weight="fill" aria-hidden="true" /> {error}</p>}

          <footer className="assistant-footer">
            <span className={`assistant-runtime assistant-runtime--${modelState}`}><span aria-hidden="true" />{runtimeStatus(modelState, assistant)}</span>
            <span>Changes always require confirmation</span>
          </footer>
        </div>
      </section>
    </div>
  );
}

function AssistantResultView({ result, applying, onApply, onCancel }: {
  result: AssistantResult;
  applying: boolean;
  onApply: (proposal: AssistantProposal) => Promise<void>;
  onCancel: () => void;
}) {
  if (result.type !== "proposal") {
    return (
      <section className={`assistant-result assistant-result--${result.type}`} aria-live="polite">
        <p className="assistant-result__label">{result.type === "unsupported" ? "Needs clarification" : result.type === "help" ? "What I can do" : "From your inventory"}</p>
        <p>{result.message}</p>
      </section>
    );
  }
  return (
    <section className="assistant-proposal" aria-labelledby="assistant-proposal-title">
      <p className="assistant-result__label">Review before saving</p>
      <h3 id="assistant-proposal-title">Proposed change to {result.itemName}</h3>
      <table className="assistant-proposal__comparison">
        <thead><tr><th scope="col">Field</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead>
        <tbody>
          {result.changes.name && <tr><th scope="row">Primary name</th><td>{result.current.name}</td><td>{result.changes.name}</td></tr>}
          {result.changes.alternativeNames && <tr><th scope="row">Alternative names</th><td>{result.current.alternativeNames.join(", ") || "None"}</td><td>{result.changes.alternativeNames.join(", ") || "None"}</td></tr>}
          {result.changes.categories && <tr><th scope="row">Categories</th><td>{result.current.categories.join(", ")}</td><td>{result.changes.categories.join(", ")}</td></tr>}
        </tbody>
      </table>
      <div className="assistant-proposal__actions">
        <button className="button button--quiet" type="button" onClick={onCancel} disabled={applying}>Cancel</button>
        <button className="button button--primary" type="button" onClick={() => void onApply(result)} disabled={applying}>{applying ? "Saving…" : "Confirm change"}</button>
      </div>
    </section>
  );
}

function runtimeStatus(state: ModelState, assistant: BrowserAssistant): string {
  if (state === "loading") return "Downloading locally";
  if (state === "thinking") return "Running locally";
  if (state === "ready") return assistant.runtimeLabel();
  if (state === "error") return "Local model paused";
  return "Model off";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
