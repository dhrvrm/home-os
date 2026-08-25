# Inventory Levels and Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an understandable 0-100 stock meter for approximate inventory and show learned consumption frequency without weakening the existing Go, SQLite, or PWA boundaries.

**Architecture:** Extend the existing inventory domain rather than adding another subsystem. Simple-tracked items persist a percentage and derive their named stock state from that percentage; exact items keep quantity-based state. Consumption cadence is derived from recent consume events in the domain service, while SQLite stores the new values and migrates existing database files in place. The Next.js client renders the percentage as a semantic meter and cadence as concise row text.

**Tech Stack:** Go 1.24, `net/http`, `database/sql`, modernc SQLite, Next.js 16, React 19, TypeScript, Vitest, semantic CSS, Cloudflare Workers Static Assets.

---

## File map

- `apps/api/internal/inventory/model.go`: percentage and cadence contract.
- `apps/api/internal/inventory/service.go`: level transitions, cadence calculation, and item enrichment.
- `apps/api/internal/inventory/service_test.go`: domain transition and cadence regressions.
- `apps/api/internal/storage/sqlite/schema.sql`: fresh-database columns.
- `apps/api/internal/storage/sqlite/repository.go`: legacy migration plus percentage persistence.
- `apps/api/internal/storage/sqlite/repository_test.go`: reopen and legacy migration coverage.
- `apps/api/internal/httpapi/router_test.go`: JSON contract coverage.
- `apps/web/src/lib/inventory.ts`: client contract.
- `apps/web/src/lib/format.ts`: cadence and percentage labels.
- `apps/web/src/components/item-form.tsx`: initial approximate level input.
- `apps/web/src/components/item-row.tsx`: semantic 0-100 meter and cadence display.
- `apps/web/src/components/inventory-app.test.tsx`: interaction and rendering coverage.
- `apps/web/src/app/globals.css`: meter and responsive treatment.
- `README.md`, `docs/architecture.md`: user-facing behavior and migration notes.

### Task 1: Domain percentage model

**Files:**
- Modify: `apps/api/internal/inventory/model.go`
- Modify: `apps/api/internal/inventory/service.go`
- Modify: `apps/api/internal/inventory/service_test.go`

- [x] **Step 1: Write failing level transition tests**

Add tests asserting that a simple item defaults to 50 percent, consuming without an explicit amount subtracts 25 points, restocking sets 100, and marking a level accepts zero through 100 while rejecting values outside that range.

- [x] **Step 2: Run the focused level tests and confirm failure**

Run:

```bash
go test -count=1 ./apps/api/internal/inventory -run 'TestService.*Level|TestServiceCreatesItemWithSafeDefaults' -v
```

Expected: FAIL because `LevelPercent` and percentage transitions are not implemented.

- [x] **Step 3: Implement the domain contract**

Add `LevelPercent float64` to `Item` and `StockEvent`, and `LevelPercent *float64` to `CreateItemInput` and `ApplyEventInput`. For simple items, use these thresholds:

```text
0       -> out
1-25    -> low
26-75   -> okay
76-100  -> full
```

Default a new simple item to 50. A simple consume event subtracts the provided positive number of percentage points or 25 when omitted. Restock sets 100. `mark_level` requires an explicit percentage. Exact item behavior remains quantity-based.

- [x] **Step 4: Run the domain level tests**

Run the focused command from Step 2.

Expected: PASS.

### Task 2: Consumption cadence

**Files:**
- Modify: `apps/api/internal/inventory/model.go`
- Modify: `apps/api/internal/inventory/service.go`
- Modify: `apps/api/internal/inventory/service_test.go`

- [x] **Step 1: Write failing cadence tests**

Cover fewer than two consume events returning no cadence, unsorted events producing the correct average interval, future and non-consume events being ignored, and confidence increasing at four and eight samples.

- [x] **Step 2: Run the cadence tests and confirm failure**

Run:

```bash
go test -count=1 ./apps/api/internal/inventory -run TestCalculateCadence -v
```

Expected: FAIL because cadence types and calculation do not exist.

- [x] **Step 3: Implement cadence enrichment**

Add this response shape:

```go
type Cadence struct {
    AverageIntervalDays float64    `json:"averageIntervalDays"`
    EventsPerWeek       float64    `json:"eventsPerWeek"`
    LastConsumedAt      time.Time  `json:"lastConsumedAt"`
    Confidence          Confidence `json:"confidence"`
}
```

Calculate it from consume event timestamps in the existing 90-day window. Use the interval between first and last event divided by `count - 1`, round displayed values to one decimal place, and reuse the existing low/medium/high confidence thresholds. Enrich items with both forecast and cadence through one helper.

- [x] **Step 4: Run all domain tests**

Run:

```bash
go test -count=1 ./apps/api/internal/inventory -v
```

Expected: PASS.

### Task 3: SQLite migration and persistence

**Files:**
- Modify: `apps/api/internal/storage/sqlite/schema.sql`
- Modify: `apps/api/internal/storage/sqlite/repository.go`
- Modify: `apps/api/internal/storage/sqlite/repository_test.go`

- [x] **Step 1: Write failing persistence tests**

Verify a simple item's percentage survives close and reopen, event percentages are returned, and opening a database created with the previous items/events schema adds both percentage columns without losing the old row.

- [x] **Step 2: Run storage tests and confirm failure**

Run:

```bash
go test -count=1 ./apps/api/internal/storage/sqlite -v
```

Expected: FAIL because percentage columns and legacy migration are absent.

- [x] **Step 3: Implement schema and idempotent migration**

Fresh tables include constrained `level_percent` columns. During `Open`, inspect `PRAGMA table_info` and add missing columns for legacy files. Backfill old simple items from their stock state (`full=100`, `okay=50`, `low=25`, `out=0`). Update every select, insert, update, and event scan consistently.

- [x] **Step 4: Run storage tests**

Run the command from Step 2.

Expected: PASS.

### Task 4: HTTP JSON contract

**Files:**
- Modify: `apps/api/internal/httpapi/router_test.go`

- [x] **Step 1: Extend transport tests**

Assert create requests accept `levelPercent`, response items expose it, and event requests can send an explicit zero percentage with `mark_level`.

- [x] **Step 2: Run transport tests**

Run:

```bash
go test -count=1 ./apps/api/internal/httpapi -v
```

Expected: PASS because the transport decodes the extended domain structs without adding routes.

### Task 5: Web contract and interaction

**Files:**
- Modify: `apps/web/src/lib/inventory.ts`
- Modify: `apps/web/src/lib/format.ts`
- Modify: `apps/web/src/components/item-form.tsx`
- Modify: `apps/web/src/components/item-row.tsx`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/components/inventory-app.test.tsx`

- [x] **Step 1: Write failing UI tests**

Add fixtures with `levelPercent` and cadence. Assert a simple row exposes an accessible meter with `50%`, cadence text renders as `Used about every 4 days`, consuming sends 25 percentage points, and the create form sends its selected starting level.

- [x] **Step 2: Run the web tests and confirm failure**

Run:

```bash
npm test --workspace @home-os/web
```

Expected: FAIL because the client types and level UI are absent.

- [x] **Step 3: Implement the client contract and form**

Add `levelPercent` and optional cadence to the TypeScript types. In simple mode, show a labeled range input from 0 to 100 in 25-point steps with a live numeric output; omit it for exact mode. Send the selected value through create.

- [x] **Step 4: Implement the row meter and cadence**

Render a semantic `<meter min="0" max="100">` only for simple items, plus visible percentage text. Preserve exact quantity display. Use plain cadence copy and retain the existing forecast as the secondary exact-item signal. Simple `Use` sends `{ type: "consume", quantity: 25 }`; restock remains one action.

- [x] **Step 5: Run web tests**

Run the command from Step 2.

Expected: PASS.

### Task 6: Responsive visual treatment and copy

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [x] **Step 1: Style the semantic meter**

Use the existing green accent for healthy levels and existing warning/danger tokens for low/out states. Keep one compact meter treatment, preserve the current radius system, and ensure mobile rows do not overflow at 390px.

- [x] **Step 2: Update documentation**

Explain simple percentage thresholds, automatic 25-point consumption, cadence learning, and the in-place SQLite migration. Do not change the deployment boundary.

- [x] **Step 3: Run the visible-copy scan**

Run:

```bash
rg -n '[—–]' apps/web/src apps/web/public README.md docs
```

Expected: no output.

### Task 7: Release verification and publication

**Files:**
- Modify: `.ai/plans/2026-08-25-inventory-levels-cadence.md`

- [x] **Step 1: Run complete verification**

Run:

```bash
go test -count=1 -race ./apps/api/...
npm test --workspace @home-os/web
make lint
make build
npm audit
npm run deploy --workspace @home-os/web -- --dry-run
```

Expected: every command exits zero, no test or lint failures, and Wrangler reads the static export.

- [x] **Step 2: Inspect both themes and mobile layout**

Render seeded inventory at 1440px light/dark and an emulated 390px viewport. Confirm the meter, cadence, controls, and dialog remain legible with no horizontal overflow. Run Lighthouse accessibility and require 100.

- [x] **Step 3: Review and commit**

Run secret scanning, `git diff --check`, and inspect the complete staged diff. Commit with:

```bash
git commit -m "feat: add inventory levels and cadence"
```

- [x] **Step 4: Integrate and publish**

Fast-forward `main`, push `origin/main`, and confirm the GitHub CI run completes successfully.
