# Browser Inventory Assistant Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add a privacy-first inventory assistant that lazily runs a small instruction model in the browser, answers simple inventory questions, and proposes guarded rename, alternative-name, and category edits for explicit confirmation.

**Architecture:** Keep all inference in the browser using `@wllama/wllama` and a Q4_K_M GGUF of SmolLM2-135M-Instruct. Wllama owns its internal worker and selects its WebGPU/WASM execution path without blocking React. The inference adapter returns text only. A separate deterministic parser allowlists a narrow command schema and resolves item IDs against the current inventory. Read-only inventory questions are answered by deterministic local query functions whenever possible. Mutations are sent to a narrow PATCH metadata endpoint only after a user confirms the rendered proposal.

**Tech Stack:** Go 1.25 service, SQLite, Next.js 16 static export, React 19, TypeScript 5.9, Wllama 3.6/llama.cpp WebAssembly and WebGPU, Vitest/Testing Library, Cloudflare Workers static assets.

**Design contract:** This is a targeted evolution of the current native CSS system. Preserve Geist typography, forest-green tokens, pill buttons, existing dialog behavior, navigation structure, light/dark modes, and responsive breakpoints. Use a compact topbar utility action and focused modal—not a floating chat bubble. Use `DESIGN_VARIANCE: 4`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 7`. Include idle, consent, download progress, ready, thinking, proposal, success, unsupported-command, and error states. Trap focus, restore it on close, honor reduced motion, and expose progress/results through live regions.

---

## Task 1: Add guarded metadata updates to the domain

**Files:**
- Modify: `apps/api/internal/inventory/model.go`
- Modify: `apps/api/internal/inventory/repository.go`
- Modify: `apps/api/internal/inventory/service.go`
- Modify: `apps/api/internal/inventory/service_test.go`

**Steps:**
1. Add `UpdateItemMetadataInput` with pointer fields for `name`, `alternativeNames`, and `categories`, so omitted fields retain their current values while explicitly empty aliases are accepted.
2. Add `UpdateItemMetadata(context.Context, Item)` to `Repository`.
3. Implement `Service.UpdateItemMetadata`: serialize with `mutationMu`, fetch the item, merge only supplied values, trim and validate the name, reuse `normalizeValues`, keep compatibility `Category` equal to the first category, retain existing categories when omitted, reject an explicitly empty category list, update `UpdatedAt`, persist, and re-enrich forecast/cadence.
4. Extend the in-memory repository and add tests covering rename, Hindi alternative names, multi-category replacement, omitted fields, duplicate removal, invalid empty name/categories, and preservation of stock fields.
5. Run `go test ./apps/api/internal/inventory`.

## Task 2: Persist and expose metadata updates

**Files:**
- Modify: `apps/api/internal/storage/sqlite/repository.go`
- Modify: `apps/api/internal/storage/sqlite/repository_test.go`
- Modify: `apps/api/internal/httpapi/router.go`
- Modify: `apps/api/internal/httpapi/router_test.go`

**Steps:**
1. Add a transactional SQLite `UpdateItemMetadata` method that updates the item name, compatibility category, and timestamp; deletes and reinserts alternative names and categories; returns `ErrNotFound` when no row changes; and commits atomically.
2. Add repository tests proving metadata replacement survives a round trip and stock/forecast source data is untouched.
3. Extend `InventoryService` and register `PATCH /api/v1/items/{id}`.
4. Decode with the existing strict JSON decoder, return the standard item envelope, allow PATCH in CORS, and retain the existing validation/not-found error mapping.
5. Add HTTP tests for success, invalid fields, unknown JSON keys, and missing item.
6. Run `go test ./apps/api/internal/storage/sqlite ./apps/api/internal/httpapi`.

## Task 3: Define deterministic assistant commands and queries

**Files:**
- Add: `apps/web/src/lib/categories.ts`
- Add: `apps/web/src/lib/inventory-assistant.ts`
- Add: `apps/web/src/lib/inventory-assistant.test.ts`
- Modify: `apps/web/src/components/item-form.tsx`
- Modify: `apps/web/src/lib/inventory.ts`
- Modify: `apps/web/src/lib/api.ts`

**Steps:**
1. Move the shared category vocabulary into `categories.ts` and reuse it in item creation and model prompting.
2. Add the web `UpdateItemMetadataInput` type and `updateItemMetadata` PATCH client.
3. Define the worker/UI message protocol and an allowlisted result union: `answer`, `proposal`, `help`, and `unsupported`. A proposal may contain only a resolved item ID plus name, aliases, and categories.
4. Implement deterministic local queries for low/out stock, counts, locations, categories, and exact item lookup. These should answer common questions without loading a model.
5. Build a compact inventory snapshot and system prompt that instructs the model to emit one JSON object, never invent IDs, keep user-language text, and select only supported categories.
6. Parse the first valid JSON object from model text, enforce string/array limits, normalize aliases/categories, resolve referenced item names to actual IDs, reject ambiguous/missing items, and turn all mutations into proposals.
7. Add unit tests for deterministic English queries, alias/Hindi item matching, valid rename/categorize JSON, malformed output, invented item IDs, overlong values, unsupported intents, and mutation confirmation payloads.
8. Run `npm test -- --run src/lib/inventory-assistant.test.ts` from `apps/web`.

## Task 4: Run the model lazily with Wllama

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Add: `apps/web/src/lib/browser-assistant.ts`
- Add: `apps/web/src/lib/browser-assistant.test.ts`

**Steps:**
1. Install exact `@wllama/wllama@3.6.0` and keep the audit at zero known vulnerabilities.
2. Configure Wllama’s packaged runtime assets for the static export. Dynamically import Wllama only after `load`; let its internal worker select WebGPU/WASM and keep React responsive.
3. Keep the GGUF repository, filename, SHA-256, approximate download size, and runtime metadata in one exported constant. Report download progress in the UI; do not include model weights in the app bundle or service worker precache.
4. Use deterministic generation (`temperature: 0`, bounded token count) with the current snapshot and prompt, returning plain model text to the parser.
5. Implement a browser client with one reusable Wllama instance, typed load/generate promises, progress subscribers, error propagation, and `dispose`.
6. Add tests with a fake runtime for lifecycle reuse, progress, responses, errors, and disposal. Do not download model weights in tests.
7. Run the focused web tests and TypeScript/ESLint checks.

## Task 5: Build the assistant confirmation UI

**Files:**
- Add: `apps/web/src/components/inventory-assistant.tsx`
- Add: `apps/web/src/components/inventory-assistant.test.tsx`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/app/globals.css`

**Steps:**
1. Add an “Ask Home” secondary action beside “Add item”; preserve the three-slot mobile navigation by exposing the same action in the inventory panel header on narrow screens.
2. Build an accessible dialog using the current focus trap/restore pattern. Lead with a local/privacy explanation and an explicit “Enable local assistant” action before any model download.
3. Show the selected runtime, download percentage/bytes when available, cache note, and a WASM fallback label. Keep all states real and driven by the worker protocol.
4. After ready, show one concise prompt field and suggested actions such as “What is running low?”, “Rename Dish soap to Washing-up liquid”, and “Add Kitchen to Rice categories.”
5. Run deterministic queries first. Load/use the model only when the request needs language interpretation. Render answers directly; render mutations as a before/after proposal with Cancel and Confirm buttons.
6. On confirmation call `updateItemMetadata`, update the parent inventory state, announce success, and never automatically apply generated output.
7. Add component tests for no download before consent, progress, deterministic query without inference, generated proposal, cancel, confirm/PATCH, worker error, focus trap/restore, and empty inventory.
8. Add responsive styles, high-contrast focus/error/progress states, reduced-motion behavior, and no gradients or nested-card clutter.

## Task 6: Verify free deployment constraints and publish

**Files:**
- Modify: `README.md`
- Modify: `apps/web/public/sw.js` only if cache rules need to exclude generated worker/model URLs

**Steps:**
1. Document browser requirements, privacy boundary, first-run model download, WebGPU/WASM behavior, supported assistant actions, confirmation safety, and known small-model limitations including weaker Hindi generation.
2. Run `gofmt` on changed Go files.
3. Run `make test`, `npm run lint`, and `npm run build`.
4. Run Wrangler dry-run deployment and inspect output asset sizes; confirm no single static asset breaches Cloudflare’s current Workers asset constraint and no model weight is bundled.
5. Inspect the static export and service worker to confirm the model stays remotely fetched and lazily browser-cached.
6. Review the diff for unrelated changes, secret material, generated caches, placeholders, and dependency/audit issues.
7. Use the requesting-code-review and verification-before-completion skills, address findings, commit the feature branch, fast-forward `main`, rerun verification on `main`, and push `dhrvrm/home-os`.

## Safety invariants

- Model code and weights load only after explicit consent.
- Inventory data is passed to the browser-local worker, not to a hosted inference endpoint.
- Model output is untrusted text until parsed through the allowlist.
- The model cannot create network/API calls or directly mutate data.
- Every rename, alias, or category change requires a visible confirmation.
- Unsupported or ambiguous commands fail closed without changing inventory.
- Existing stock actions and item creation behavior remain unchanged.
