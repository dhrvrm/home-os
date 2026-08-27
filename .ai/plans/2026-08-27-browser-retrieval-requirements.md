# Browser Retrieval and Product Requirements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a grounded, private browser assistant that retrieves relevant household inventory locally, uses the small model only as a constrained query planner, and establish a traceable functional and non-functional requirements ledger for the complete Home OS product.

**Architecture:** Inventory remains authoritative in Dexie/D1. A pure TypeScript retrieval module ranks structured inventory records using exact multilingual names, aliases, categories, locations, stock facets, and token overlap; no embedding model or network service is required. Deterministic code answers known questions and executes every model-produced read plan or proposed mutation, while the model sees only a bounded retrieved snapshot and never emits user-visible facts directly.

**Tech Stack:** Next.js static PWA, TypeScript, Dexie, Wllama 3.6, SmolLM2-135M-Instruct Q4_K_M, Vitest, Testing Library, Hono, Cloudflare Workers, D1.

---

## File structure

- Create `docs/requirements.md`: canonical product functional/non-functional requirement IDs, acceptance measures, release status, and traceability.
- Create `apps/web/src/lib/assistant-retrieval.ts`: normalization, tokenization, structured inventory indexing, scoring, bounded retrieval, and evidence metadata.
- Create `apps/web/src/lib/assistant-retrieval.test.ts`: multilingual ranking, field weighting, broad-query fallback, bounds, determinism, and scale coverage.
- Modify `apps/web/src/lib/inventory-assistant.ts`: consume retrieval results, add deterministic quantity/forecast/cadence/status questions, and parse model query plans without trusting model-authored facts.
- Modify `apps/web/src/lib/inventory-assistant.test.ts`: query coverage, grounding, prompt budgets, invented evidence rejection, and safety tests.
- Modify `apps/web/src/lib/browser-assistant.ts`: storage estimation, persistence request, required-headroom check, runtime capability reporting, and offline-cache-friendly runtime configuration.
- Modify `apps/web/src/lib/browser-assistant.test.ts`: storage readiness, unsupported API, insufficient quota, persistence, load reuse, and failure tests.
- Modify `apps/web/src/components/inventory-assistant.tsx`: use retrieval context, report evidence/provenance, expose storage readiness, and retain accessible confirmation semantics.
- Modify `apps/web/src/components/inventory-assistant.test.tsx`: provenance, storage failure, model fallback, consent, focus, and mutation confirmation tests.
- Modify `apps/web/src/app/globals.css`: compact evidence and readiness presentation using the existing visual system.
- Modify `README.md`, `docs/architecture.md`, and `docs/product-architecture.md`: document the hybrid retrieval boundary, privacy behavior, requirements reference, and measured constraints.

### Task 1: Canonical product requirement ledger

**Files:**
- Create: `docs/requirements.md`
- Modify: `README.md`
- Modify: `docs/product-architecture.md`

- [ ] **Step 1: Write functional requirements with stable identifiers**

Create a release-traceable matrix covering platform/household identity, offline-first inventory, shopping/notifications, contacts/documents, shared expenses, chores/maintenance, calendar/automations, MCP/connectors, and the browser assistant. Each row must use this schema:

```markdown
| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-AST-01 | Common inventory questions are answered from local structured data without loading a model. | Quantity, status, location, category, low/out, forecast, and cadence test cases pass while the runtime factory remains unused. | Current iteration |
```

Mark implemented behavior as `Shipped`, this iteration as `Current iteration`, and later module behavior as `Planned — iteration N`. Do not label an unimplemented module as available.

- [ ] **Step 2: Write measurable non-functional requirements**

Cover availability/degradation, offline behavior, performance, storage, security/privacy, integrity/concurrency, accessibility, compatibility, observability, maintainability, recovery, and cost. Use measurable statements, including:

```markdown
| NFR-PERF-01 | Deterministic query and retrieval code handles 1,000 inventory records without network access and bounds model context to 3,800 UTF-8 bytes. |
| NFR-PRIV-01 | Inventory, prompts, retrieved evidence, and model output are never sent to a hosted inference API. |
| NFR-SAFE-01 | Model output cannot directly mutate state; every command is schema-validated and every accepted mutation requires visible confirmation. |
| NFR-OFF-01 | Installed clients can read cached inventory and queue supported commands without connectivity; deterministic assistant queries continue to work. |
| NFR-STOR-01 | Before a 105 MB model download, the client estimates quota, reserves at least 32 MB or 25% headroom, requests persistent storage when supported, and fails with a recoverable message when capacity is known to be insufficient. |
```

- [ ] **Step 3: Add traceability and scope rules**

Map each shipped/current requirement to its tests, API route, or implementation module. State that the requirement ledger describes the complete product while each iteration implements a coherent subset.

- [ ] **Step 4: Link the ledger from product documentation**

Add a `Requirements` link to `README.md` and a short traceability section to `docs/product-architecture.md`.

- [ ] **Step 5: Validate documentation and commit**

Run:

```bash
rg -n "FR-|NFR-" docs/requirements.md
rg -n "TBD|TODO|implement later" docs/requirements.md
git diff --check
```

Expected: stable IDs are present, the placeholder scan has no output, and `git diff --check` exits 0.

Commit:

```bash
git add docs/requirements.md docs/product-architecture.md README.md
git commit -m "docs: define home os product requirements"
```

### Task 2: Local structured retrieval

**Files:**
- Create: `apps/web/src/lib/assistant-retrieval.ts`
- Create: `apps/web/src/lib/assistant-retrieval.test.ts`

- [ ] **Step 1: Write failing retrieval tests**

Test this public contract:

```ts
export interface InventoryEvidence {
  item: InventoryItem;
  score: number;
  matchedFields: Array<"name" | "alternativeName" | "category" | "location" | "stockLevel" | "unit">;
}

export interface InventoryRetrieval {
  evidence: InventoryEvidence[];
  totalItems: number;
  omittedItems: number;
  normalizedTerms: string[];
  strategy: "ranked" | "attention-fallback";
}

export function retrieveInventory(request: string, items: InventoryItem[], limit?: number): InventoryRetrieval;
```

Cases must prove exact primary-name ranking, exact Hindi alias ranking, category/location weighting, low/out synonym facets, stable tie order, duplicate-token handling, a useful attention-first fallback for broad language, a hard maximum of 12 evidence records, and correct behavior for 1,000 records.

- [ ] **Step 2: Run tests and observe the missing-module failure**

Run:

```bash
npm run test --workspace @home-os/web -- --run src/lib/assistant-retrieval.test.ts
```

Expected: FAIL because `assistant-retrieval.ts` does not exist.

- [ ] **Step 3: Implement deterministic retrieval**

Implement Unicode-aware `NFKC` folding and tokenization, stop-word removal for common English query glue, exact phrase boosts, weighted field token overlap, stock synonym facets, stable original-index tie breaking, and an attention-first fallback. Keep the module pure and do not read Dexie or access the network.

The default retrieval limit is 12. Return copies of matched-field arrays and never mutate the source inventory.

- [ ] **Step 4: Run retrieval tests**

Run the targeted test command again.

Expected: all retrieval tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/assistant-retrieval.ts apps/web/src/lib/assistant-retrieval.test.ts
git commit -m "feat: add local inventory retrieval"
```

### Task 3: Grounded query execution and prompt construction

**Files:**
- Modify: `apps/web/src/lib/inventory-assistant.ts`
- Modify: `apps/web/src/lib/inventory-assistant.test.ts`

- [ ] **Step 1: Write failing deterministic query tests**

Add exact expected results for:

```text
How much rice is left?
What is the status of साबुन?
When will rice run out?
How often do we use rice?
What categories is rice in?
What should I buy?
```

Cover absent forecast/cadence, ambiguous aliases, simple percentage and exact quantity formatting, confidence text, and item IDs used as evidence.

- [ ] **Step 2: Write failing grounded model-plan tests**

Extend the allowlist with:

```json
{"intent":"inspect","item":"existing item name or id","field":"status|quantity|location|categories|forecast|cadence"}
```

Prove that an inspect plan is executed against the current `InventoryItem`, an invented item is rejected, unsupported fields are rejected, extra keys fail closed, and no model-authored prose is surfaced.

- [ ] **Step 3: Replace snapshot prioritization with retrieval**

Export:

```ts
export interface AssistantContext {
  prompt: { system: string; user: string };
  retrieval: InventoryRetrieval;
}

export function buildAssistantContext(request: string, items: InventoryItem[]): AssistantContext;
```

Preserve `buildAssistantPrompt()` as a compatibility wrapper returning `.prompt`. Compose the user message from retrieved evidence only, include `totalItems`, `omittedItemCount`, and retrieval strategy, and retain the 3,800-byte combined prompt ceiling.

- [ ] **Step 4: Implement deterministic inspect execution**

Use one internal `answerForField(item, field)` function for both regex-handled queries and model inspect plans. Every result must include the authoritative item ID. Forecasts and cadence are guidance and must include their confidence level.

- [ ] **Step 5: Run assistant unit tests and commit**

```bash
npm run test --workspace @home-os/web -- --run src/lib/assistant-retrieval.test.ts src/lib/inventory-assistant.test.ts
git add apps/web/src/lib/inventory-assistant.ts apps/web/src/lib/inventory-assistant.test.ts
git commit -m "feat: ground assistant queries in retrieved inventory"
```

Expected: both suites pass.

### Task 4: Browser storage readiness and model resilience

**Files:**
- Modify: `apps/web/src/lib/browser-assistant.ts`
- Modify: `apps/web/src/lib/browser-assistant.test.ts`

- [ ] **Step 1: Write failing readiness tests**

Define and test:

```ts
export interface ModelStorageReadiness {
  canDownload: boolean;
  requiredBytes: number;
  availableBytes: number | null;
  persisted: boolean | null;
  reason: "ready" | "insufficient-storage" | "estimate-unavailable";
}

export interface BrowserStorageManager {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}
```

Cover sufficient space, insufficient space, missing StorageManager methods, rejected estimates, already-persistent storage, and persistence requests made only after explicit model enablement.

- [ ] **Step 2: Implement readiness with bounded headroom**

Calculate `requiredBytes` as model bytes plus `max(32 MiB, ceil(model bytes * 0.25))`. If a quota estimate is unavailable, permit the attempt with `estimate-unavailable`; if known free bytes are below the requirement, fail before Wllama downloads. Request persistent storage when supported.

- [ ] **Step 3: Integrate readiness into BrowserAssistant**

Add `prepareStorage()` and cache its successful result for the assistant lifecycle. Configure Wllama with local model caching and offline cache reuse. Preserve lazy loading, progress, deterministic generation, abort, and disposal behavior.

- [ ] **Step 4: Run runtime tests and commit**

```bash
npm run test --workspace @home-os/web -- --run src/lib/browser-assistant.test.ts
git add apps/web/src/lib/browser-assistant.ts apps/web/src/lib/browser-assistant.test.ts
git commit -m "feat: guard local model storage readiness"
```

Expected: all runtime tests pass without downloading model weights.

### Task 5: Evidence-aware accessible assistant UI

**Files:**
- Modify: `apps/web/src/components/inventory-assistant.tsx`
- Modify: `apps/web/src/components/inventory-assistant.test.tsx`
- Modify: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write failing component tests**

Add tests proving:

- deterministic answers show an evidence label without loading the model;
- model-routed requests show how many local records were retrieved;
- insufficient storage prevents runtime loading and shows a recoverable alert;
- unavailable storage estimates do not block loading;
- prompts and model output are not written to local storage;
- model proposals still require confirmation;
- evidence UI is available to assistive technology and contains no fake citations.

- [ ] **Step 2: Use AssistantContext during generation**

Build the retrieval context once per request, pass only `context.prompt` to Wllama, parse the plan against the complete current inventory, and retain the evidence metadata for display. Clear evidence when a new request begins or a proposal is cancelled.

- [ ] **Step 3: Add storage readiness states**

On “Enable local assistant”, call `assistant.prepareStorage()` before `load()`. Display known required/available space when insufficient, otherwise keep the current download progress. Do not request storage permission before consent.

- [ ] **Step 4: Render provenance without exposing implementation noise**

For deterministic answers, show `Answered from local inventory · N record(s)`. For model-planned requests, show `Interpreted locally · N retrieved record(s) · Answer verified against inventory`. Keep the live region concise and retain focus trapping/restoration.

- [ ] **Step 5: Run component and app tests and commit**

```bash
npm run test --workspace @home-os/web -- --run src/components/inventory-assistant.test.tsx src/components/inventory-app.test.tsx
git add apps/web/src/components/inventory-assistant.tsx apps/web/src/components/inventory-assistant.test.tsx apps/web/src/app/globals.css
git commit -m "feat: expose grounded assistant evidence"
```

Expected: both suites pass and existing inventory behavior remains unchanged.

### Task 6: Architecture and operational documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/product-architecture.md`
- Modify: `docs/deployment.md`

- [ ] **Step 1: Document the retrieval boundary**

State explicitly that retrieval is local structured lexical/facet retrieval, not vector storage; the model translates ambiguous language into an allowlisted plan; facts and mutations are evaluated deterministically against current inventory; and model prompts/results are ephemeral.

- [ ] **Step 2: Document browser/runtime constraints**

Document the 105 MB first-run download, OPFS/origin storage, quota preflight, persistent-storage request, WebGPU/WASM behavior, offline cache reuse, browser eviction possibility, and deterministic fallback.

- [ ] **Step 3: Record requirement traceability**

Link shipped assistant requirement IDs to test suites and describe the remaining planned product modules without presenting them as deployed.

- [ ] **Step 4: Validate and commit**

```bash
rg -n "retrieval|105 MB|persistent storage|deterministic" README.md docs
git diff --check
git add README.md docs/architecture.md docs/product-architecture.md docs/deployment.md
git commit -m "docs: explain local retrieval assistant"
```

Expected: documentation search finds each operational boundary and the diff check passes.

### Task 7: Full verification, deployment, and publication

**Files:**
- Verify all changed files

- [ ] **Step 1: Run repository verification**

```bash
npm test
npm run lint
npm run build
npm run smoke
git diff --check
```

Expected: all web and Worker tests pass, ESLint and TypeScript pass, the Next static export and Worker dry-run succeed, the nine-step real Worker+D1 lifecycle smoke passes, and no whitespace errors remain.

- [ ] **Step 2: Inspect deploy contents**

Confirm no `.gguf` file appears in `apps/web/out`, model weights are not part of the Worker asset manifest, and the service worker does not precache a model URL.

```bash
find apps/web/out -type f -name '*.gguf'
rg -n "huggingface|gguf" apps/web/out/sw.js apps/web/public/sw.js
```

Expected: no GGUF files and no model URL in the service worker.

- [ ] **Step 3: Deploy the verified Worker**

```bash
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npm run deploy --workspace=@home-os/worker
```

Expected: Wrangler reports the `home-os` Worker URL and a new version ID.

- [ ] **Step 4: Smoke-test production**

Verify `/`, `/healthz`, `/readyz`, `/api/v1/items`, unauthenticated MCP rejection, and authenticated MCP initialization. Never print the MCP credential.

- [ ] **Step 5: Publish safely**

```bash
git push origin feat/browser-rag-requirements
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Expected: the ancestry check passes and public `main` advances by fast-forward.

## Self-review

- Functional coverage: the ledger covers the full product map; implementation tasks cover the current browser retrieval slice only and label future modules accurately.
- Non-functional coverage: privacy, offline degradation, bounded context, storage, safety, accessibility, integrity, verification, recovery, and cost receive measurable acceptance statements.
- Placeholder scan: the plan contains no unspecified implementation step; later product scope is represented as explicit requirement status rather than placeholder code.
- Type consistency: `InventoryRetrieval`, `AssistantContext`, and `ModelStorageReadiness` are defined once and referenced consistently by tests, implementation, and UI tasks.
