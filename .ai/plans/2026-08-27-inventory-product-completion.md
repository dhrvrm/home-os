# Inventory Product Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current inventory prototype into a dependable inventory-first Home OS release with deterministic local startup, correct stock transitions, direct item management, visible history, a useful shopping view, backup export, and honest offline read access.

**Architecture:** Keep Go as the owner of inventory rules and SQLite as the local file database. Make the browser client use relative `/api` requests, with a development-only Next proxy to the Go server and a single supervised startup command. Extend the existing event-backed inventory domain instead of creating parallel state, while caching the latest server projection in the browser only as a clearly labelled read-only offline fallback.

**Tech Stack:** Go 1.24, `net/http`, modernc SQLite, Next.js 16 static SPA/PWA, React 19, TypeScript, Vitest, Testing Library, Node-based smoke tests.

---

## File structure

- Create `scripts/dev.mjs`: supervise fixed-port API and web development processes, perform port preflight, wait for readiness, and shut down both children together.
- Create `scripts/smoke.mjs`: exercise the real HTTP API and dev proxy with create, update, consume, history, archive, restore, and reload checks.
- Modify `Makefile` and root `package.json`: expose `dev`, `smoke`, and existing component commands consistently.
- Modify `apps/web/next.config.ts`: add development-only `/api/:path*` and `/healthz` rewrites while preserving static export in production.
- Modify `apps/web/src/lib/api.ts` and tests: use a relative API base by default, add timeout/cancellation, and add typed get/update/history/archive/restore/export calls.
- Create `apps/web/src/lib/inventory-cache.ts` and tests: persist and validate the last successful inventory projection for read-only offline startup.
- Modify `apps/api/internal/inventory/model.go`: add complete update input, archive state, event notes, and export types.
- Modify `apps/api/internal/inventory/repository.go`: expose readiness, complete item update, archive/restore, and full history operations.
- Modify `apps/api/internal/inventory/service.go` and tests: enforce stock invariants, record actual consumption, validate complete edits, and expose history/archive/restore.
- Modify `apps/api/internal/storage/sqlite/schema.sql`, repository, and tests: migrate archive/event-note columns, persist complete edits, implement readiness, and keep history available through archive/restore.
- Modify `apps/api/internal/httpapi/router.go` and tests: add readiness, item GET/PATCH, history, archive/restore, export, structured CORS errors, and logging around CORS.
- Create `apps/web/src/components/item-edit-dialog.tsx`: edit names, aliases, categories, location, unit, and thresholds without AI.
- Create `apps/web/src/components/stock-dialog.tsx`: accept exact quantities and arbitrary simple 0–100 adjustments.
- Create `apps/web/src/components/item-detail-dialog.tsx`: show item facts and its immutable stock history.
- Create `apps/web/src/components/shopping-view.tsx`: derive a usable buy-next list from low/out items and restock from that view.
- Modify `apps/web/src/components/item-row.tsx`, `inventory-app.tsx`, tests, and CSS: wire direct management, archive/restore, stable sorting, offline state, and functional Inventory/Shopping views.
- Modify `apps/web/public/sw.js`: bump the shell cache and retain shell-only behavior without pretending API responses are safely writable offline.
- Modify `.env.example`, `README.md`, `docs/architecture.md`, `docs/deployment.md`, and CI: document the supported topology and run the real smoke path.

### Task 1: Deterministic local topology and actionable networking

- [ ] **Step 1: Write failing API-client and CORS tests**

Add assertions that the default client requests `/api/v1/items`, timeouts produce code `timeout`, and a denied origin receives the normal JSON envelope. Add a server-wiring test for the supported development URL `http://localhost:3100`.

```ts
expect(fetchMock).toHaveBeenCalledWith("/api/v1/items", expect.any(Object));
await expect(listItems({ timeoutMs: 1 })).rejects.toMatchObject({ code: "timeout" });
```

```go
if got := response.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
	t.Fatalf("content type = %q", got)
}
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `go test ./apps/api/internal/httpapi && npm test --workspace @home-os/web -- src/lib/api.test.ts`

Expected: failures for the absolute localhost URL, missing timeout code, and plain-text CORS rejection.

- [ ] **Step 3: Implement the same-origin client and development proxy**

Use an empty default base in `api.ts`, merge caller abort signals with a bounded timeout, and map `AbortError`, `navigator.onLine === false`, and HTTP envelopes to distinct stable codes. In `next.config.ts`, return rewrites only when `NODE_ENV !== "production"`:

```ts
async rewrites() {
  if (process.env.NODE_ENV === "production") return [];
  const target = process.env.HOMEOS_API_PROXY ?? "http://127.0.0.1:8080";
  return [
    { source: "/api/:path*", destination: `${target}/api/:path*` },
    { source: "/healthz", destination: `${target}/healthz` },
    { source: "/readyz", destination: `${target}/readyz` },
  ];
}
```

- [ ] **Step 4: Add one supervised development command**

`scripts/dev.mjs` must preflight ports 8080 and 3100, spawn `go run ./cmd/server` in `apps/api`, spawn `next dev --port 3100` through the workspace npm script, poll `/readyz` and `/`, print one URL, forward SIGINT/SIGTERM, and terminate the sibling when either child exits unexpectedly.

- [ ] **Step 5: Make transport errors structured and observable**

Wrap CORS inside request logging and use `writeJSON` for forbidden origins. Add `GET /readyz` backed by a repository `Ping(ctx)` query (`SELECT 1`) so readiness proves SQLite access.

- [ ] **Step 6: Run focused verification and commit**

Run: `make test && make lint && npm run build`

Expected: all checks pass; production static export contains no development rewrite error.

Commit: `fix: make local home os startup reliable`

### Task 2: Trustworthy stock semantics and complete item operations

- [ ] **Step 1: Write failing domain invariant tests**

Cover these exact cases:

```go
// Restocking 1 unit into an exact item with min 10 remains low, never full.
// Consuming 8 from an available quantity of 3 records quantity 3 and leaves 0.
// A 121-rune name, 81-rune location, or 31-rune unit is rejected on create and update.
// Updating metadata/location/unit/minimum never changes stock unless an event is used.
// Archive hides an item from active lists, history survives, and restore returns it.
```

- [ ] **Step 2: Run domain and repository tests and confirm failure**

Run: `go test ./apps/api/internal/inventory ./apps/api/internal/storage/sqlite`

Expected: failures demonstrate the current forced-full restock, inflated consumption event, missing edit validation, and absent archive operations.

- [ ] **Step 3: Extend the model without duplicating state**

Add `ArchivedAt *time.Time`, `Note string` on stock events, and pointer-based `UpdateItemInput` fields for `name`, `alternativeNames`, `categories`, `location`, `unit`, and `minQuantity`. Keep quantity and meter level changes event-only.

```go
type UpdateItemInput struct {
	Name             *string    `json:"name"`
	AlternativeNames *[]string  `json:"alternativeNames"`
	Categories       *[]string  `json:"categories"`
	Location         *string    `json:"location"`
	Unit             *string    `json:"unit"`
	MinQuantity      *float64   `json:"minQuantity"`
}
```

- [ ] **Step 4: Correct event transitions**

For exact restock, derive state with `exactLevel(next.Quantity, next.MinQuantity)`. For over-consumption, store `min(requested, available)` as the event quantity. Validate event notes to 240 runes. Preserve the service mutation lock and repository transaction.

- [ ] **Step 5: Add complete edit, history, archive, and restore ports**

Repository and service operations:

```go
GetItem(context.Context, string) (Item, error)
UpdateItem(context.Context, Item) (Item, error)
ArchiveItem(context.Context, string, time.Time) (Item, error)
RestoreItem(context.Context, string, time.Time) (Item, error)
ListEvents(context.Context, string, time.Time) ([]StockEvent, error)
Ping(context.Context) error
```

Default listing excludes archived items; `?archived=only` returns them. Archive is reversible and never deletes events.

- [ ] **Step 6: Add routes and migrate SQLite idempotently**

Routes:

```text
GET    /api/v1/items/{id}
PATCH  /api/v1/items/{id}
DELETE /api/v1/items/{id}
POST   /api/v1/items/{id}/restore
GET    /api/v1/items/{id}/events
```

Add nullable `archived_at` and non-null `note` with an empty default through migration checks so existing databases open without data loss.

- [ ] **Step 7: Run race and persistence verification and commit**

Run: `go test -race ./apps/api/...`

Expected: all tests pass with no races; reopen tests prove archived state and history survive.

Commit: `feat: complete inventory item lifecycle`

### Task 3: Direct management, item history, and practical stock controls

- [ ] **Step 1: Write failing component tests**

Test direct editing without the assistant, an exact consume amount of `2.5`, a simple adjustment to `35%`, history rendering, archive confirmation, archived view restore, and attention-first re-sorting after mutation.

```ts
await user.click(screen.getByRole("button", { name: /edit rice/i }));
await user.clear(screen.getByLabelText("Location"));
await user.type(screen.getByLabelText("Location"), "Kitchen shelf");
await user.click(screen.getByRole("button", { name: /save changes/i }));
expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/items/rice"), expect.objectContaining({ method: "PATCH" }));
```

- [ ] **Step 2: Run focused web tests and confirm failure**

Run: `npm test --workspace @home-os/web -- src/components/inventory-app.test.tsx`

Expected: the direct management controls and views are absent.

- [ ] **Step 3: Implement edit and stock dialogs**

`ItemEditDialog` edits all mutable non-stock fields and supports comma-separated custom aliases/categories alongside suggested category chips. `StockDialog` accepts positive decimal exact amounts and a 0–100 range for simple `mark_level`, with a note field for history.

- [ ] **Step 4: Implement item detail and history**

Open details from each row, fetch events on demand, format event type/amount/time/note, and expose Edit and Archive actions. Maintain focus trapping and restoration using the established dialog pattern.

- [ ] **Step 5: Add archived inventory and stable sorting**

Use one comparator after loads and every mutation: active attention order (`out`, `low`, `okay`, `full`) then locale-aware name. Add Active/Archived filtering and restore in the archived view.

- [ ] **Step 6: Verify accessibility and commit**

Run: `npm test --workspace @home-os/web && npm run lint --workspace @home-os/web`

Expected: component and assistant suites pass; all dialog buttons have unique accessible names.

Commit: `feat: add direct inventory management and history`

### Task 4: Shopping loop, backup, and honest offline fallback

- [ ] **Step 1: Write failing shopping/cache/export tests**

Cover low/out derivation, restock removal from buy-next, cached projection recovery after a network failure, corrupt cache rejection, and a downloadable JSON export containing items and events.

- [ ] **Step 2: Implement the shopping view**

Enable the existing navigation. Derive shopping entries from active low/out items, retain category/location context, and invoke the same tested restock dialog. This first release intentionally has no parallel shopping database; inventory state is the source of truth.

- [ ] **Step 3: Implement validated offline read cache**

Store `{ version: 1, savedAt, items }` after successful loads and mutations. On initial network failure, validate every required item field before showing cached data. Display a persistent “Offline copy from … — changes are disabled” banner and never queue a mutation that could replay twice.

- [ ] **Step 4: Implement full JSON backup export**

Add `GET /api/v1/export` returning a versioned payload with active/archived items and their complete events. The UI downloads `home-os-backup-YYYY-MM-DD.json`. Do not call this restore support; document database restore separately until a transactional import is implemented.

- [ ] **Step 5: Update the service worker and product language**

Bump the shell cache name, keep API data out of the generic Cache API, and describe the exact offline behavior in the UI/README: shell plus last successful read, with writes disabled offline.

- [ ] **Step 6: Verify and commit**

Run: `make test && make lint && make build`

Expected: all unit, integration, lint, and production export checks pass.

Commit: `feat: close the inventory shopping and backup loop`

### Task 5: Real-stack smoke test, CI, documentation, and release handoff

- [ ] **Step 1: Implement the real HTTP smoke test**

The smoke script starts an isolated API with a temporary SQLite path and a web dev server on unused fixed test ports, waits conditionally for readiness, then verifies through the web origin:

```text
GET empty inventory -> POST exact item -> PATCH location -> POST consume
-> GET history -> DELETE archive -> GET archived -> POST restore -> GET item
```

It must terminate both processes and remove only its own temporary directory on success or failure.

- [ ] **Step 2: Add smoke to CI**

Run the smoke job after unit tests and before build artifacts. Preserve current Go race, web tests, lint, and build checks.

- [ ] **Step 3: Update documentation**

Document `make dev` as the default startup, `http://localhost:3100` as the supported URL, `/readyz`, offline-read limitations, backup export, archive semantics, and the MIT/AGPL clean-room research boundary. Correct the API route list and remove any implication that the static shell alone is a complete offline app.

- [ ] **Step 4: Full verification**

Run:

```bash
make test
make lint
make build
npm run smoke
go test -race ./apps/api/...
git diff --check
```

Expected: every command exits zero; smoke output identifies each successful real-stack operation.

- [ ] **Step 5: Review, commit, merge, and push**

Use the requesting-code-review and verification-before-completion skills. Commit remaining docs/CI as `test: verify the complete inventory product path`, fast-forward `main`, push `dhrvrm/home-os`, restart the supported local stack, and verify the public repository points at the pushed commit.

---

## Deferred product modules

Contacts, shared expenses, chores, authentication/households, barcode catalogs, durable-asset warranties, fully queued offline writes, and a Cloudflare D1 adapter remain separate subsystems. The inventory release must leave clean boundaries for them, but it must not pretend they exist. The next plan should introduce the shared household/membership model first, then expenses (Spliit-style tested arithmetic), chores, and contacts.

