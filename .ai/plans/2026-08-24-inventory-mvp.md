# Home OS Inventory MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish an installable roommate inventory app with a maintainable Go API, SQLite persistence, categorization, stock events, and consumption forecasts.

**Architecture:** Keep the web client and API as independent applications joined by a versioned HTTP contract. The Go service owns inventory rules behind a repository interface and persists to a single SQLite file; the Next.js app is a client-side static export that can run locally, be installed as a PWA, and deploy through Cloudflare Workers Static Assets. Cloudflare deployment of persistence still requires either a Worker-native D1 API or a separately hosted Go API because Workers do not provide a durable local filesystem.

**Tech Stack:** Go 1.24, `net/http`, `database/sql`, `modernc.org/sqlite`, Next.js 16, React 19, TypeScript, Phosphor icons, semantic CSS, Web App Manifest, service worker.

---

## File map

- `apps/api/cmd/server/main.go`: configuration, dependency wiring, server lifecycle.
- `apps/api/internal/inventory/`: domain models, validation, repository port, service, forecasting.
- `apps/api/internal/storage/sqlite/`: schema migration and SQLite repository adapter.
- `apps/api/internal/httpapi/`: JSON transport, routes, errors, CORS, and request logging.
- `apps/web/src/app/`: Next.js static-export shell, metadata, manifest, and root page.
- `apps/web/src/components/`: inventory workspace, add-item form, filters, item rows, navigation.
- `apps/web/src/lib/`: typed API client, inventory types, formatting helpers.
- `apps/web/public/sw.js`: cache-first app-shell service worker with network-first API behavior.
- `docs/architecture.md`: subsystem boundaries and API/persistence decisions.
- `apps/web/wrangler.jsonc`: Workers Static Assets deployment configuration.
- `docs/deployment.md`: local, self-hosted, and Cloudflare Workers deployment paths.

### Task 1: Repository foundation

**Files:**
- Create: `.gitignore`
- Create: `go.work`
- Create: `package.json`
- Create: `Makefile`
- Create: `README.md`

- [x] **Step 1: Add workspace metadata and ignore generated state**

Use a Go workspace pointing at `./apps/api`, an npm workspace pointing at `apps/web`, and ignore `node_modules`, `.next`, `out`, `.env*`, coverage output, and `*.db*` while retaining `.env.example`.

- [x] **Step 2: Add root commands**

Provide `make dev-api`, `make dev-web`, `make test`, `make lint`, and `make build`. `make test` must run both Go and web tests; `make build` must compile the Go server and static Next export.

- [x] **Step 3: Document the first-run workflow**

The README must use these commands:

```bash
npm install
go work sync
make dev-api
make dev-web
```

- [x] **Step 4: Verify workspace metadata**

Run: `go work edit -json && npm pkg get workspaces`

Expected: both applications are present.

### Task 2: Inventory domain using TDD

**Files:**
- Create: `apps/api/go.mod`
- Create: `apps/api/internal/inventory/model.go`
- Create: `apps/api/internal/inventory/repository.go`
- Create: `apps/api/internal/inventory/service.go`
- Create: `apps/api/internal/inventory/service_test.go`

- [x] **Step 1: Write service tests first**

Cover creation defaults, blank-name rejection, exact consumption, simple stock transitions, restocking, and forecast confidence. Use an in-memory repository test double implementing:

```go
type Repository interface {
    ListItems(context.Context, Filter) ([]Item, error)
    GetItem(context.Context, string) (Item, error)
    CreateItem(context.Context, Item) (Item, error)
    ApplyEvent(context.Context, StockEvent) (Item, error)
}
```

- [x] **Step 2: Run the focused test and confirm failure**

Run: `go test ./internal/inventory -run TestService -v`

Expected: FAIL because the domain implementation does not exist.

- [x] **Step 3: Implement the minimum domain**

Use explicit enums:

```go
type TrackingMode string
const (
    TrackingSimple TrackingMode = "simple"
    TrackingExact  TrackingMode = "exact"
)

type StockLevel string
const (
    StockFull StockLevel = "full"
    StockOkay StockLevel = "okay"
    StockLow  StockLevel = "low"
    StockOut  StockLevel = "out"
)
```

`Item` contains identity, category, location, unit, tracking mode, quantity, stock level, minimum quantity, timestamps, and an optional `Forecast`. `Service.ApplyEvent` validates the transition and delegates atomic persistence to the repository.

- [x] **Step 4: Run domain tests**

Run: `go test ./internal/inventory -v`

Expected: PASS.

### Task 3: SQLite repository using TDD

**Files:**
- Create: `apps/api/internal/storage/sqlite/schema.sql`
- Create: `apps/api/internal/storage/sqlite/repository.go`
- Create: `apps/api/internal/storage/sqlite/repository_test.go`

- [x] **Step 1: Write repository integration tests**

Use `t.TempDir()` and verify create/list/get, atomic event application, persisted category/location, and forecast inputs after closing and reopening the database.

- [x] **Step 2: Run and confirm failure**

Run: `go test ./internal/storage/sqlite -v`

Expected: FAIL because the repository is absent.

- [x] **Step 3: Add schema and repository**

Create indexed `items` and `stock_events` tables. Configure WAL mode, foreign keys, a busy timeout, and a single writer connection. Apply events inside a SQL transaction and calculate forecast summaries from consumption history.

- [x] **Step 4: Run storage tests**

Run: `go test ./internal/storage/sqlite -v`

Expected: PASS.

### Task 4: HTTP API using TDD

**Files:**
- Create: `apps/api/internal/httpapi/router.go`
- Create: `apps/api/internal/httpapi/router_test.go`
- Create: `apps/api/cmd/server/main.go`

- [x] **Step 1: Write transport tests**

Test `GET /healthz`, `GET /api/v1/items`, `POST /api/v1/items`, `POST /api/v1/items/{id}/events`, validation failures, not-found responses, JSON content types, and CORS preflight.

- [x] **Step 2: Run and confirm failure**

Run: `go test ./internal/httpapi -v`

Expected: FAIL because no router exists.

- [x] **Step 3: Implement handlers with the standard library**

Use Go 1.22 route patterns and this response envelope:

```json
{"data": {}, "error": null}
```

Return `201` for item creation, `200` for event application, `400` for invalid requests, and `404` for missing items. Limit request bodies and recover panics without leaking details.

- [x] **Step 4: Wire the server**

Read `HOMEOS_ADDR`, `HOMEOS_DB_PATH`, and `HOMEOS_ALLOWED_ORIGINS`; use sensible local defaults and graceful shutdown.

- [x] **Step 5: Run all Go tests**

Run: `go test ./...`

Expected: PASS.

### Task 5: Next.js SPA and PWA shell

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/eslint.config.mjs`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/manifest.ts`
- Create: `apps/web/src/app/globals.css`
- Create: `apps/web/public/sw.js`
- Create: `apps/web/public/icon.svg`
- Create: `apps/web/src/components/pwa-register.tsx`
- Create: `apps/web/wrangler.jsonc`

- [x] **Step 1: Configure a static SPA export**

Set `output: "export"`, `trailingSlash: true`, and no server-only Next features. Use system-safe local fonts to keep the offline shell independent of external font requests.

- [x] **Step 2: Add installability metadata**

Define a standalone manifest with the Home OS name, inventory description, theme colors, portrait orientation, and SVG icon. Register `/sw.js` only in production.

- [x] **Step 3: Implement app tokens and responsive shell**

Use semantic CSS variables with system light/dark modes, one muted green accent, 14px surfaces, pill action buttons, visible focus rings, reduced-motion support, and mobile navigation.

- [x] **Step 4: Verify the static shell**

Run: `npm run build --workspace @home-os/web`

Expected: Next.js exports `apps/web/out` successfully.

- [x] **Step 5: Configure Workers Static Assets**

Point the Worker's assets directory at `./out`, enable SPA not-found handling, and add `npm run preview` and `npm run deploy` commands using Wrangler. Static asset requests should bypass Worker code unless an API route is added.

### Task 6: Functional inventory experience using TDD

**Files:**
- Create: `apps/web/src/lib/inventory.ts`
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/format.ts`
- Create: `apps/web/src/components/inventory-app.tsx`
- Create: `apps/web/src/components/item-form.tsx`
- Create: `apps/web/src/components/item-row.tsx`
- Create: `apps/web/src/components/empty-state.tsx`
- Create: `apps/web/src/components/inventory-app.test.tsx`
- Create: `apps/web/src/app/page.tsx`

- [x] **Step 1: Write interaction tests**

Mock fetch and cover loading, API failure, empty inventory, filtering, item creation, consumption, restocking, and low/out transitions.

- [x] **Step 2: Run and confirm failure**

Run: `npm test --workspace @home-os/web`

Expected: FAIL because inventory components are absent.

- [x] **Step 3: Implement the API client and product UI**

The client reads `NEXT_PUBLIC_API_URL`, uses typed JSON envelopes, and provides actionable error messages. The workspace includes household summary, search, category filters, an accessible add-item dialog, responsive inventory rows, stock controls, and forecast language such as `Likely low in 6 days`.

- [x] **Step 4: Implement complete states**

Loading uses layout-matched skeletons. Empty state explains how to add the first item. Fetch and mutation errors appear inline with retry. Optimistic updates are not used until conflict semantics exist.

- [x] **Step 5: Run web tests and build**

Run: `npm test --workspace @home-os/web && npm run build --workspace @home-os/web`

Expected: PASS and static export succeeds.

### Task 7: Documentation and deployment boundary

**Files:**
- Create: `.env.example`
- Create: `docs/architecture.md`
- Create: `docs/deployment.md`
- Modify: `README.md`

- [x] **Step 1: Document local and self-hosted operation**

Explain that SQLite is durable on a laptop, home server, VPS, or container with a mounted volume. Include backup instructions based on SQLite's online backup command.

- [x] **Step 2: Document the Cloudflare Workers path**

State clearly that Cloudflare recommends Workers for new projects and that Workers Static Assets can serve the exported Next.js PWA. Workers have no durable local filesystem. Describe D1 plus a TypeScript Worker transport as the native free all-Cloudflare option; treat Go-on-Wasm as an optimization experiment because Cloudflare does not provide first-class Go bindings for D1.

- [x] **Step 3: Add free-tier expectations**

Record Cloudflare's current Workers Static Assets, Workers, and D1 free quotas with dated official links. Do not promise that free tiers are permanent.

### Task 8: Verification and publication

**Files:**
- Modify: plan checkboxes as tasks complete.

- [x] **Step 1: Format and lint**

Run: `gofmt -w apps/api && go vet ./apps/api/... && npm run lint --workspace @home-os/web`

Expected: no diagnostics.

- [x] **Step 2: Run full verification**

Run: `make test && make build`

Expected: all tests pass and both production builds succeed.

- [x] **Step 3: Run frontend pre-flight**

Check responsive widths, both color schemes, keyboard focus, visible copy, PWA manifest/service-worker paths, and scan visible strings for forbidden dash characters.

- [x] **Step 4: Initialize and commit**

Run:

```bash
git init -b main
git add .
git commit -m "feat: launch Home OS inventory MVP"
```

- [x] **Step 5: Publish publicly**

Run:

```bash
gh repo create sw-dhruv/home-os --public --source=. --remote=origin --push
```

Expected: GitHub reports the public repository URL and `main` tracks `origin/main`.
