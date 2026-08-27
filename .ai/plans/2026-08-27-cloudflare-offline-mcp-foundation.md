# Cloudflare Offline MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the network-dependent Go/SQLite deployment with a Cloudflare-native, offline-first Home OS foundation that preserves the complete inventory behavior, records an auditable change history, and exposes a secured read-only MCP inventory surface without closing off future household modules.

**Architecture:** A single Cloudflare Worker serves the static Next.js PWA, a Hono `/api/v1` application API, and an authenticated stateless `/mcp` endpoint. D1 is the shared household source of truth; Dexie is the browser-local working database and outbox; every accepted command flows through one application service and appends an audit event, regardless of whether it originated in the PWA, sync, MCP, import, or automation. The first deployment remains a modular monolith: later contacts, expenses, chores, documents, notifications, and integration modules reuse household identity, commands, audit, sync, and MCP authorization rather than creating separate runtimes.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers Static Assets, Hono, D1, Dexie 4, Next.js static export, Vitest with Cloudflare Workers pool, Model Context Protocol 2025-11-25 Streamable HTTP, Wrangler 4.125.0.

---

## Locked system boundaries

- `apps/worker/src/platform` owns environment bindings, IDs, clocks, authentication, errors, command context, sync envelopes, and audit persistence.
- `apps/worker/src/inventory` owns inventory vocabulary, validation, stock transitions, cadence, forecasting, repository queries, and commands.
- `apps/worker/src/http` translates HTTP requests into application commands and queries; it contains no business decisions.
- `apps/worker/src/mcp` translates MCP tools and resources into the same queries used by HTTP. Iteration one is read-only and requires a bearer secret; OAuth 2.1 replaces the adapter without changing inventory services.
- `apps/web/src/offline` owns Dexie projections, optimistic local commands, the outbox, bounded activity cache, and sync orchestration.
- Durable domain data is stored once. Notifications and MCP invocation diagnostics are bounded projections; consumption and audit history remain durable because product behavior depends on them.

## Preserved product modules and iteration order

1. Platform and complete inventory: household scope, D1, Dexie, offline writes, outbox sync, audit, MCP inventory reads.
2. Shopping and notifications: derived shopping list, manual additions, low-stock rules, bounded inbox, Web Push, quiet hours.
3. Household: roommates, roles, rooms, shared spaces, invitations, devices.
4. Important contacts and documents: emergency contacts, landlord, utilities, warranties, leases, R2 attachments.
5. Shared expenses: Splitwise-style expenses, shares, balances, settlements, recurring bills, exports.
6. Chores and maintenance: assignments, recurrence, completion, appliance and repair history.
7. Calendar and household automation: due dates, subscriptions, utility reminders, rule execution.
8. External connectors: import/export and separately authorized MCP integrations for calendars, finance, messaging, and shopping.

Each later module receives an independent implementation plan and ships as working software. Navigation exposes only capabilities that are actually deployed.

### Task 1: Record the product information architecture and platform decisions

**Files:**
- Create: `docs/product-architecture.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Write the architecture document**

Define the durable navigation and data boundaries:

```text
Home
├── Overview
├── Inventory
│   ├── Items
│   ├── Categories
│   ├── Locations
│   ├── Shopping
│   └── Insights
├── Household
│   ├── Members
│   ├── Spaces
│   ├── Contacts
│   └── Documents
├── Money
│   ├── Expenses
│   ├── Balances
│   └── Settlements
├── Tasks
│   ├── Chores
│   └── Maintenance
├── Activity
├── Automations
└── Settings
```

Document common entity metadata (`id`, `householdId`, `version`, timestamps, archive marker), command metadata (`operationId`, actor, device, source, expected version), audit retention, notification bounds, and the module roadmap listed above.

- [ ] **Step 2: Replace the obsolete runtime diagram**

Use this deployment shape in `docs/architecture.md`:

```text
Next.js PWA ── local commands ──> Dexie projections + outbox
     │                                  │
     └──────── Cloudflare Worker <──── sync
                 ├── Hono API
                 ├── MCP endpoint
                 ├── D1
                 ├── R2 (later document module)
                 └── Queue/Cron (later notification module)
```

- [ ] **Step 3: Update README promises and commands**

State precisely what works offline, what MCP exposes, what remains in later iterations, and replace Go runtime instructions only after the Worker migration passes.

- [ ] **Step 4: Commit the documentation boundary**

```bash
git add docs README.md .ai/plans
git commit -m "docs: define cloudflare home os platform roadmap"
```

### Task 2: Scaffold the Worker and D1 schema

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/wrangler.jsonc`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/migrations/0001_platform_inventory.sql`
- Create: `apps/worker/src/env.ts`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/test/health.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write a failing Worker health test**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker health", () => {
  it("serves the API health contract", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request("https://home-os.test/healthz"), env, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { status: "ok" }, error: null });
  });
});
```

- [ ] **Step 2: Run the test and verify the missing Worker fails**

Run: `npm test --workspace @home-os/worker -- --run test/health.test.ts`

Expected: FAIL because `../src/index` does not exist.

- [ ] **Step 3: Add the Worker package and bindings**

Pin Hono, Dexie-independent server libraries, MCP SDK, Cloudflare test pool, Wrangler, TypeScript, and Vitest. Configure one D1 binding named `DB`, one static asset binding named `ASSETS`, and route `/api/*`, `/mcp`, `/healthz`, and `/readyz` through the Worker before static assets.

Use an environment contract with no optional production database:

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOMEOS_MCP_TOKEN?: string;
  HOMEOS_DEFAULT_HOUSEHOLD_ID: string;
}
```

- [ ] **Step 4: Create the initial D1 schema**

Create normalized tables for `households`, `members`, `inventory_items`, `inventory_alternative_names`, `categories`, `inventory_item_categories`, `inventory_stock_events`, `processed_operations`, and `audit_events`. Use foreign keys, household-qualified indexes, an integer `version` on items, a unique `(household_id, operation_id)` idempotency key, and an auto-increment audit `sequence`.

- [ ] **Step 5: Implement and pass the health test**

Create a Hono application and return the existing `{data,error}` envelope from `/healthz`. Run:

```bash
npm test --workspace @home-os/worker -- --run test/health.test.ts
npm run cf-typegen --workspace @home-os/worker
```

Expected: health test PASS and generated binding types compile.

- [ ] **Step 6: Commit the Worker foundation**

```bash
git add package.json package-lock.json apps/worker
git commit -m "feat: add cloudflare worker and d1 foundation"
```

### Task 3: Port inventory behavior into the shared application service

**Files:**
- Create: `apps/worker/src/platform/context.ts`
- Create: `apps/worker/src/platform/errors.ts`
- Create: `apps/worker/src/platform/ids.ts`
- Create: `apps/worker/src/inventory/model.ts`
- Create: `apps/worker/src/inventory/validation.ts`
- Create: `apps/worker/src/inventory/forecast.ts`
- Create: `apps/worker/src/inventory/repository.ts`
- Create: `apps/worker/src/inventory/service.ts`
- Create: `apps/worker/test/inventory-service.test.ts`

- [ ] **Step 1: Write failing parity tests**

Cover primary and alternative names, case-insensitive deduplication, multiple ordered categories, simple 0–100 tracking, exact quantities, consume/restock/mark-level transitions, low/out states, archive/restore, cadence after two uses, and run-out forecasts. Include this command context:

```ts
export interface CommandContext {
  householdId: string;
  actorId: string;
  actorType: "member" | "mcp" | "automation" | "import";
  source: "pwa" | "mcp" | "automation" | "import";
  operationId: string;
  deviceId?: string;
  mcpClientId?: string;
  mcpTool?: string;
}
```

- [ ] **Step 2: Run parity tests and verify failure**

Run: `npm test --workspace @home-os/worker -- --run test/inventory-service.test.ts`

Expected: FAIL because inventory modules are absent.

- [ ] **Step 3: Implement the pure inventory rules**

Port the tested Go behavior without HTTP or D1 dependencies. Enforce eight alternative names, nine categories, 120-character names, valid percentages, non-negative quantities, and deterministic enrichment from stock events.

- [ ] **Step 4: Implement application commands and queries**

Expose `listItems`, `getItem`, `createItem`, `updateItem`, `applyStockEvent`, `archiveItem`, `restoreItem`, and `listItemEvents`. Every mutating method accepts `CommandContext` and calls a repository operation that atomically changes domain rows, records `processed_operations`, and appends one audit event.

- [ ] **Step 5: Run parity tests**

Run: `npm test --workspace @home-os/worker -- --run test/inventory-service.test.ts`

Expected: all inventory service tests PASS.

- [ ] **Step 6: Commit the domain port**

```bash
git add apps/worker/src apps/worker/test
git commit -m "feat: port inventory domain to typescript"
```

### Task 4: Implement D1 persistence, audit, and the Hono API

**Files:**
- Create: `apps/worker/src/platform/audit.ts`
- Create: `apps/worker/src/inventory/d1-repository.ts`
- Create: `apps/worker/src/http/envelope.ts`
- Create: `apps/worker/src/http/request-context.ts`
- Create: `apps/worker/src/http/inventory-routes.ts`
- Create: `apps/worker/src/http/activity-routes.ts`
- Create: `apps/worker/test/inventory-api.test.ts`
- Create: `apps/worker/test/audit.test.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Write failing API and audit tests**

Verify all current `/api/v1/items` endpoints, JSON export, request validation, idempotent replay by `X-Operation-ID`, optimistic conflict by `If-Match`, and household/activity filtering. Verify a stock change creates exactly one append-only audit row containing safe field deltas, actor, source, operation ID, entity ID, client timestamp, server timestamp, and authoritative sequence.

- [ ] **Step 2: Run the integration tests and verify failure**

Run:

```bash
npm test --workspace @home-os/worker -- --run test/inventory-api.test.ts test/audit.test.ts
```

Expected: FAIL because routes and D1 repository are absent.

- [ ] **Step 3: Implement D1 repository transactions**

Use prepared statements and `DB.batch()` so each logical mutation updates the item, writes any stock event and membership rows, inserts the idempotency result, and appends the audit event as one atomic batch. Store RFC 6902-shaped safe deltas, never complete snapshots, access tokens, push endpoints, or private attachment content.

- [ ] **Step 4: Implement HTTP translation**

Preserve the `/api/v1` contract while adding `X-Operation-ID`, `X-Device-ID`, `X-Client-Time`, and version conflict behavior. Return stable error codes: `invalid_request`, `not_found`, `conflict`, `unauthorized`, and `internal_error`.

- [ ] **Step 5: Add household activity endpoints**

Implement:

```text
GET /api/v1/activity?after=&limit=&entityType=&entityId=&actorId=
GET /api/v1/items/{id}/activity?after=&limit=
```

Cap pages at 100 rows and expose opaque sequence cursors.

- [ ] **Step 6: Run API and audit tests**

Expected: all integration tests PASS.

- [ ] **Step 7: Commit persistence and transport**

```bash
git add apps/worker
git commit -m "feat: add d1 inventory api and audit trail"
```

### Task 5: Add offline-first Dexie projections and sync

**Files:**
- Create: `apps/web/src/offline/db.ts`
- Create: `apps/web/src/offline/schema.ts`
- Create: `apps/web/src/offline/commands.ts`
- Create: `apps/web/src/offline/sync.ts`
- Create: `apps/web/src/offline/use-inventory.ts`
- Create: `apps/web/src/offline/db.test.ts`
- Create: `apps/web/src/offline/sync.test.ts`
- Create: `apps/worker/src/sync/model.ts`
- Create: `apps/worker/src/sync/routes.ts`
- Create: `apps/worker/test/sync.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/public/sw.js`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing local transaction tests**

Verify an offline create, metadata update, stock event, archive, and restore each update the local projection and enqueue exactly one operation in the same Dexie transaction. Use this schema:

```ts
interface OutboxOperation {
  operationId: string;
  householdId: string;
  deviceId: string;
  kind: "inventory.create" | "inventory.update" | "inventory.stock" | "inventory.archive" | "inventory.restore";
  entityId: string;
  expectedVersion: number;
  clientTime: string;
  payload: unknown;
  state: "pending" | "sending" | "conflict";
}
```

- [ ] **Step 2: Write failing server sync tests**

Verify `POST /api/v1/sync` accepts at most 50 operations, replays operation IDs safely, returns per-operation results, returns changed current projections after the audit cursor, and advances the cursor only through returned changes.

- [ ] **Step 3: Implement Dexie 4 storage**

Create tables for items, stock events, outbox, recent audit activity, and singleton sync state. Index alternative search text, categories, location, stock level, archive marker, event time, outbox state, and audit sequence. Bound local audit storage to 30 days or 2,000 rows, whichever is smaller.

- [ ] **Step 4: Implement the sync endpoint**

Translate each operation through the same inventory application service. Return conflicts without overwriting local intent, then return authoritative item/event projections and audit rows after the supplied cursor.

- [ ] **Step 5: Switch the UI to local-first reads and writes**

Render from Dexie, write locally without checking `navigator.onLine`, and trigger sync on startup, visibility regain, manual retry, and browser `online`. Treat Background Sync only as an enhancement. Display `saved on this device`, `syncing`, `synced`, or `needs review` states.

- [ ] **Step 6: Keep the service worker limited to application assets**

Do not cache API responses in Cache Storage. Dexie owns structured data; the service worker owns the static shell and model runtime assets.

- [ ] **Step 7: Run offline and sync tests**

```bash
npm test --workspace @home-os/worker -- --run test/sync.test.ts
npm test --workspace @home-os/web -- --run src/offline/db.test.ts src/offline/sync.test.ts src/components/inventory-app.test.tsx
```

Expected: all tests PASS, including mutations performed with fetch unavailable.

- [ ] **Step 8: Commit offline-first behavior**

```bash
git add apps/web apps/worker package-lock.json
git commit -m "feat: make inventory offline first with dexie sync"
```

### Task 6: Expose a secured read-only MCP inventory surface

**Files:**
- Create: `apps/worker/src/mcp/auth.ts`
- Create: `apps/worker/src/mcp/server.ts`
- Create: `apps/worker/src/mcp/tools.ts`
- Create: `apps/worker/src/mcp/resources.ts`
- Create: `apps/worker/test/mcp.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `docs/deployment.md`

- [ ] **Step 1: Write failing authentication and tool tests**

Verify `/mcp` rejects missing or incorrect bearer credentials, does not leak whether a token prefix was correct, lists only read-only inventory tools, returns structured content conforming to declared output schemas, and cannot mutate D1.

- [ ] **Step 2: Run MCP tests and verify failure**

Run: `npm test --workspace @home-os/worker -- --run test/mcp.test.ts`

Expected: FAIL because the MCP route is absent.

- [ ] **Step 3: Implement constant-time personal bearer authentication**

Hash the supplied and configured token with SHA-256 before comparing bytes. Return `401` with `WWW-Authenticate: Bearer` when authentication fails. Keep `HOMEOS_MCP_TOKEN` exclusively as a Wrangler secret.

- [ ] **Step 4: Register the iteration-one MCP contract**

Expose:

```text
Tools
- household.summary
- inventory.search
- inventory.get
- inventory.low_stock
- inventory.consumption_history
- activity.list

Resources
- homeos://households/current/summary
- homeos://households/current/inventory
- homeos://households/current/activity
```

Mark every tool read-only, return structured JSON plus a concise text representation, paginate lists, and route all queries through the same inventory and audit services used by HTTP.

- [ ] **Step 5: Record the OAuth upgrade boundary**

Document that multi-user external access replaces only `mcp/auth.ts` with Cloudflare's OAuth Provider using OAuth 2.1 audience-bound tokens and household/tool scopes. Required scopes are `home:read`, `inventory:read`, `activity:read`, with future write scopes kept separate.

- [ ] **Step 6: Run MCP tests**

Expected: all MCP tests PASS, including unauthorized, pagination, schema, and database-read-only assertions.

- [ ] **Step 7: Commit MCP**

```bash
git add apps/worker docs/deployment.md
git commit -m "feat: expose secured inventory mcp server"
```

### Task 7: Retire the Go runtime after behavioral parity

**Files:**
- Remove: `apps/api/`
- Remove: `go.work`
- Remove: `go.work.sum`
- Modify: `Makefile`
- Modify: `scripts/dev.mjs`
- Modify: `scripts/smoke.mjs`
- Modify: `.env.example`
- Modify: `docs/deployment.md`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Extend smoke coverage before removal**

Make `scripts/smoke.mjs` start Wrangler with a temporary local D1 database and verify health, create, alternative names, multiple categories, edit, decimal consumption, audit, archive, restore, sync replay, persistence after restart, and authenticated MCP list/search.

- [ ] **Step 2: Run the smoke suite against the Worker**

Run: `npm run smoke`

Expected: PASS with the Go API stopped.

- [ ] **Step 3: Remove the obsolete runtime**

Delete Go source and workspace files only after the Worker smoke suite demonstrates parity. Update development commands to run Next.js and Wrangler together, and make the production build generate the static export before Worker deployment.

- [ ] **Step 4: Run repository verification**

```bash
npm test
npm run lint
npm run build
npm run smoke
```

Expected: every command exits zero and no Go command is required.

- [ ] **Step 5: Commit runtime migration**

```bash
git add -A
git commit -m "refactor: complete cloudflare runtime migration"
```

### Task 8: Provision, deploy, verify, and publish

**Files:**
- Create: `scripts/cloudflare-env.zsh`
- Create: `docs/runbook.md`
- Modify: `.gitignore`
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `package.json`

- [ ] **Step 1: Add a credential-safe CLI wrapper**

Create a tracked wrapper that reads the API token from the macOS Keychain service `cloudflare-api-token`, exports the non-secret account ID, and executes its arguments without printing either value:

```zsh
#!/bin/zsh
set -euo pipefail
export CLOUDFLARE_ACCOUNT_ID="96cf3886ebd2c63d32d8455b9667b46c"
export CLOUDFLARE_API_TOKEN="$(security find-generic-password -a dhrvrm-home-os -s cloudflare-api-token -w)"
exec "$@"
```

- [ ] **Step 2: Create D1 and bind its identifier**

Run:

```bash
scripts/cloudflare-env.zsh npx wrangler d1 create home-os
scripts/cloudflare-env.zsh npx wrangler d1 migrations apply home-os --remote -c apps/worker/wrangler.jsonc
```

Write the returned D1 identifier into `apps/worker/wrangler.jsonc`; never write the API token.

- [ ] **Step 3: Create the MCP secret without placing it in shell history**

Generate 32 random bytes, save the value to the Keychain service `home-os-mcp-token`, and pipe it to `wrangler secret put HOMEOS_MCP_TOKEN`. Do not print the token.

- [ ] **Step 4: Deploy and run remote smoke checks**

Run:

```bash
npm run deploy
npm run smoke:remote
```

Expected: static PWA loads, API health succeeds, D1 create/sync/audit works, unauthenticated MCP fails, and authenticated MCP inventory search succeeds.

- [ ] **Step 5: Write the operations runbook**

Document migrations, deployment, token rotation, database export, D1 recovery, MCP client configuration, Access setup, incident revocation, local-data clearing, and the requirement to rotate any credential exposed outside the Keychain.

- [ ] **Step 6: Run final verification**

```bash
git status --short
npm test
npm run lint
npm run build
npm run smoke
npm run smoke:remote
```

Expected: clean or only intentional plan-tracking edits, all local checks PASS, all remote checks PASS.

- [ ] **Step 7: Commit, push, and merge**

```bash
git add -A
git commit -m "ops: deploy cloudflare home os foundation"
git push -u origin feat/cloudflare-platform-foundation
gh pr create --base main --head feat/cloudflare-platform-foundation --title "Cloudflare offline-first Home OS foundation" --body-file .ai/plans/2026-08-27-cloudflare-offline-mcp-foundation.md
gh pr merge --squash --delete-branch
git -C /Users/dhruv/Documents/code-realm/dhrvrm/home-os pull --ff-only origin main
```

Expected: `dhrvrm/home-os` main contains the verified migration and the deployed Worker revision matches that commit.

## Self-review record

- Spec coverage: inventory parity, multiple names and categories, offline-first PWA, Cloudflare Worker/Hono/D1, audit trail, bounded ephemeral state, secured MCP, retained future modules, deployment, testing, and Git publication all map to explicit tasks.
- Structural restraint: one Worker and one D1 database are sufficient for household scale; Durable Objects, Queues, R2, Workflows, and separate Workers enter only with a feature that requires their behavior.
- Security boundary: MCP never reads D1 directly, write tools are absent from iteration one, secrets remain outside Git, audit payloads exclude credentials and sensitive binary content, and multi-user MCP requires OAuth scopes before write tools exist.
- Type consistency: `CommandContext.operationId`, `OutboxOperation.operationId`, D1 `processed_operations.operation_id`, HTTP `X-Operation-ID`, and audit operation IDs are the same idempotency concept across all tasks.
