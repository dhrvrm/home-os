# Item Alternative Names and Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an inventory item have optional alternative names in any language and belong to multiple categories without breaking existing v1 clients or SQLite files.

**Architecture:** Keep `name` as the primary display identity. Add normalized `alternativeNames` and `categories` slices to the domain, while retaining singular `category` as a backward-compatible projection of the first category. Persist the multi-value fields in child tables keyed by item ID, backfill every legacy `items.category` value, and extend repository search/filtering to query all names and categories. The PWA uses one comma-separated alternative-name field and an accessible checkbox group for the fixed category vocabulary.

**Tech Stack:** Go 1.24, `net/http`, `database/sql`, modernc SQLite, Next.js 16, React 19, TypeScript, Vitest, native CSS, Cloudflare Workers Static Assets.

---

## File map

- `apps/api/internal/inventory/model.go`: alternative-name and category array contract.
- `apps/api/internal/inventory/service.go`: trimming, deduplication, defaults, limits, and legacy category projection.
- `apps/api/internal/inventory/service_test.go`: normalization and validation tests.
- `apps/api/internal/storage/sqlite/schema.sql`: child tables and lookup indexes.
- `apps/api/internal/storage/sqlite/repository.go`: metadata persistence, hydration, search, filtering, and legacy backfill.
- `apps/api/internal/storage/sqlite/repository_test.go`: reopen, search, filter, and migration tests.
- `apps/api/internal/httpapi/router_test.go`: JSON compatibility contract.
- `apps/web/src/lib/inventory.ts`: TypeScript arrays with singular compatibility field.
- `apps/web/src/components/inventory-app.tsx`: flattened category filters and multilingual search.
- `apps/web/src/components/item-form.tsx`: alternative-name field and category checkboxes.
- `apps/web/src/components/item-row.tsx`: compact alternative-name and category display.
- `apps/web/src/components/inventory-app.test.tsx`: multilingual search and form payload coverage.
- `apps/web/src/app/globals.css`: compact metadata and checkbox-group styling.
- `README.md`, `docs/architecture.md`: user behavior and migration notes.

### Task 1: Domain contract and normalization

**Files:**
- Modify: `apps/api/internal/inventory/model.go`
- Modify: `apps/api/internal/inventory/service.go`
- Modify: `apps/api/internal/inventory/service_test.go`

- [x] **Step 1: Write failing normalization tests**

Add tests that create an item with `AlternativeNames: []string{" साबुन ", "Soap", "soap", ""}` and `Categories: []string{" Cleaning ", "Kitchen", "cleaning"}`. Assert the result contains `[]string{"साबुन", "Soap"}`, `[]string{"Cleaning", "Kitchen"}`, and compatibility `Category == "Cleaning"`. Add a default test asserting missing categories become `[]string{"Other"}`. Add validation tests for more than eight values and values longer than their allowed lengths.

- [x] **Step 2: Run the focused tests and confirm RED**

```bash
go test -count=1 ./apps/api/internal/inventory -run 'TestService.*(Alternative|Categories)' -v
```

Expected: FAIL because the slice fields and normalization do not exist.

- [x] **Step 3: Add the domain fields**

Extend `Item` and `CreateItemInput`:

```go
AlternativeNames []string `json:"alternativeNames"`
Categories       []string `json:"categories"`
```

Retain `Category string` in both types as the v1 compatibility field.

- [x] **Step 4: Implement normalization**

Add a helper that trims values, drops blanks, performs case-insensitive deduplication with `strings.EqualFold`, excludes aliases equal to the primary name, and enforces limits. Allow at most eight alternative names of 120 characters each and nine categories of 60 characters each. Prefer `input.Categories`; fall back to non-empty `input.Category`; otherwise use `Other`. Set `item.Category = item.Categories[0]`.

- [x] **Step 5: Run all domain tests**

```bash
go test -count=1 ./apps/api/internal/inventory -v
```

Expected: PASS.

### Task 2: SQLite child tables and legacy migration

**Files:**
- Modify: `apps/api/internal/storage/sqlite/schema.sql`
- Modify: `apps/api/internal/storage/sqlite/repository.go`
- Modify: `apps/api/internal/storage/sqlite/repository_test.go`

- [x] **Step 1: Write failing repository tests**

Cover these cases:

- alternative names and two categories survive close and reopen in input order;
- query text matches an alternative Hindi name;
- category filtering matches a secondary category;
- opening the previous schema creates metadata tables and backfills its singular category without losing the item or percentage data.

- [x] **Step 2: Run storage tests and confirm RED**

```bash
go test -count=1 ./apps/api/internal/storage/sqlite -v
```

Expected: FAIL because metadata tables and hydration are absent.

- [x] **Step 3: Add normalized metadata tables**

Add:

```sql
CREATE TABLE IF NOT EXISTS item_alternative_names (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    PRIMARY KEY (item_id, name)
);

CREATE TABLE IF NOT EXISTS item_categories (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    category TEXT NOT NULL,
    PRIMARY KEY (item_id, category)
);
```

Add indexes for case-insensitive name/category lookups.

- [x] **Step 4: Backfill and hydrate metadata**

After schema and percentage migration, run one idempotent statement:

```sql
INSERT OR IGNORE INTO item_categories (item_id, position, category)
SELECT id, 0, category FROM items;
```

Read base item rows first, close the rows, then load ordered alternative names and categories per item. If no category child row exists, fall back to the legacy column.

- [x] **Step 5: Persist metadata atomically**

Change `CreateItem` to a transaction that inserts the base row and all child rows. Continue writing the first category to `items.category` for v1 compatibility. `ApplyEvent` keeps the existing metadata and compatibility category unchanged.

- [x] **Step 6: Extend SQL search and filtering**

Search primary name, location, legacy category, `item_alternative_names.name`, and `item_categories.category` using `EXISTS` subqueries. Category filtering uses `EXISTS` against `item_categories` so secondary memberships match.

- [x] **Step 7: Run storage tests**

```bash
go test -count=1 ./apps/api/internal/storage/sqlite -v
```

Expected: PASS.

### Task 3: HTTP compatibility contract

**Files:**
- Modify: `apps/api/internal/httpapi/router_test.go`

- [x] **Step 1: Extend the create transport test**

Send:

```json
{
  "name": "Dish soap",
  "alternativeNames": ["बर्तन धोने का साबुन", "Soap"],
  "categories": ["Cleaning", "Kitchen"]
}
```

Assert decoding preserves both arrays and the response exposes `alternativeNames`, `categories`, and singular `category: "Cleaning"`.

- [x] **Step 2: Run HTTP tests**

```bash
go test -count=1 ./apps/api/internal/httpapi -v
```

Expected: PASS after the domain contract is present; no route changes are required.

### Task 4: PWA contract, filtering, and form

**Files:**
- Modify: `apps/web/src/lib/inventory.ts`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/components/item-form.tsx`
- Modify: `apps/web/src/components/item-row.tsx`
- Modify: `apps/web/src/components/inventory-app.test.tsx`

- [x] **Step 1: Write failing UI tests**

Update fixtures with `alternativeNames` and `categories`. Assert:

- searching for `साबुन` finds `Dish soap`;
- selecting a secondary category keeps the item visible;
- the form accepts `साबुन, Soap` and submits `alternativeNames: ["साबुन", "Soap"]`;
- checking Cleaning and Kitchen submits `categories: ["Cleaning", "Kitchen"]`;
- the item row renders the aliases as `साबुन, Soap`.

- [x] **Step 2: Run web tests and confirm RED**

```bash
npm test --workspace @home-os/web
```

Expected: FAIL because the client contract and controls are singular.

- [x] **Step 3: Extend TypeScript types and filtering**

Add required `alternativeNames: string[]` and `categories: string[]` to `InventoryItem`, plus optional arrays to `CreateItemInput`. Build filter choices with `items.flatMap(item => item.categories)`. Match search against the primary name, every alternative name, every category, and location.

- [x] **Step 4: Implement the form controls**

Add a labeled `Alternative names` text input with helper copy `Separate names with commas` and placeholder `साबुन, Soap`. Parse with `split(",")`, trim, and remove blanks. Replace the category select with a `fieldset` containing the existing fixed categories as checkboxes; Food starts checked and the form sends `FormData.getAll("categories")`.

- [x] **Step 5: Render compact metadata**

Show aliases directly under the primary name only when present. Show category names joined with commas, followed by the existing location separator. Preserve current action labels and primary-name screen-reader text.

- [x] **Step 6: Run web tests**

```bash
npm test --workspace @home-os/web
```

Expected: PASS.

### Task 5: Styling, documentation, and release verification

**Files:**
- Modify: `apps/web/src/app/globals.css`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `.ai/plans/2026-08-25-item-alternatives-categories.md`

- [x] **Step 1: Style the compact controls**

Use the existing semantic tokens, radius rules, and green accent. Make category choices a wrapping checkbox grid with an obvious checked state and native focus ring. Keep aliases to one ellipsized line in inventory rows. At 390px, collapse the category grid to two columns and prevent horizontal overflow.

- [x] **Step 2: Update documentation**

Document the primary-name/alternative-name distinction, multi-category membership, multilingual search, the singular `category` compatibility projection, and automatic child-table backfill.

- [x] **Step 3: Run copy and code hygiene scans**

```bash
rg -n '[—–]' apps/web/src apps/web/public README.md docs
git diff --check
```

Expected: no output.

- [x] **Step 4: Run full automated verification**

```bash
go test -count=1 -race ./apps/api/...
npm test --workspace @home-os/web
make lint
make build
npm audit
npm run deploy --workspace @home-os/web -- --dry-run
```

Expected: every command exits zero, the audit reports zero vulnerabilities, and Wrangler reads the static export.

- [x] **Step 5: Run visual and accessibility checks**

Seed an item with a Hindi alias and two categories. Inspect the add dialog and rows at 1440px light/dark and a true 390px emulated viewport. Assert document width equals viewport width. Run Lighthouse accessibility and require 100.

- [x] **Step 6: Review, commit, and publish**

Run a credential-pattern scan, inspect the complete staged diff, and commit:

```bash
git commit -m "feat: add alternative names and categories"
```

Fast-forward `main`, push `origin/main`, and wait for GitHub CI on the exact pushed revision to succeed.
