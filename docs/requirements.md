# Home OS product requirements

This ledger defines the intended Home OS product and the measurable behavior of each release. A requirement marked **Shipped** is available in production. **Current iteration** is implemented and verified before this document is promoted to `main`. **Planned — iteration N** records an intentional product boundary; it is not a claim that the feature exists.

## Product principles

1. A household owns its data and can use core workflows without continuous connectivity.
2. Shared facts are auditable; ephemeral interface and delivery data is bounded.
3. Automation and models may propose or interpret, but domain services validate and authorize.
4. Each module is independently coherent and shares only household identity, commands, sync, authorization, and audit infrastructure.
5. The lowest-complexity platform that satisfies measured behavior is preferred.

## Functional requirements

### Platform and household boundary

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-PLT-01 | Serve the installable web application and versioned API from one Cloudflare Worker origin. | `/`, `/manifest.webmanifest`, `/api/v1`, `/healthz`, and `/readyz` are served from the deployed Worker; the web build has no Next.js server dependency. | Shipped |
| FR-PLT-02 | Keep shared household data in D1 and device projections/outbox state in Dexie. | A fresh local or production database migrates successfully; supported inventory commands update Dexie first and later reconcile through `/api/v1/sync`. | Shipped |
| FR-PLT-03 | Give every accepted mutation an idempotent operation ID, expected version, actor/source context, and audit event. | Replayed operations return the accepted result, stale versions produce explicit conflicts, and accepted changes append immutable field-level audit deltas. | Shipped |
| FR-PLT-04 | Support household members, invitations, roles, device sessions, and per-module authorization. | An owner can invite/revoke a roommate; every HTTP and MCP read/write is household- and scope-authorized; removed sessions stop working. | Planned — iteration 3 |
| FR-PLT-05 | Support complete export and recoverable archive lifecycles. | A household can export its durable records in a versioned format; archived entities are excluded from active views and can be restored where lifecycle recovery applies. | Inventory shipped; other modules planned with their iterations |

### Inventory and shopping

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-INV-01 | Create, read, edit, archive, restore, filter, and search inventory items. | UI, HTTP, sync, and repository tests cover the complete item lifecycle, archived views, names, aliases, categories, and locations. | Shipped |
| FR-INV-02 | Give an item one primary name, up to eight alternative names in any script, and one to nine categories. | Case-insensitive normalization prevents duplicates; Hindi aliases are searchable; the first category remains the compatibility projection. | Shipped |
| FR-INV-03 | Support simple 0–100 stock and exact quantity/unit stock. | Simple actions preserve a bounded percentage; exact actions preserve non-negative quantities and unit labels; both derive `full`, `okay`, `low`, or `out`. | Shipped |
| FR-INV-04 | Record every stock change as durable history and derive cadence/forecast guidance. | Consumption/restock events are append-only; two or more consumption events can produce cadence; exact usage can produce days remaining with confidence. | Shipped |
| FR-INV-05 | Work offline for supported inventory commands. | Create, edit, stock, archive, and restore update the local projection and outbox atomically; reconnect sync is idempotent and keeps conflicts for review. | Shipped |
| FR-SHP-01 | Derive a usable shopping view from low/out inventory. | Active low/out items appear with category/location context and can be restocked through the inventory stock command. | Shipped |
| FR-SHP-02 | Support manual shopping entries, quantities, notes, assignees, and completion. | Manual entries sync offline, can be assigned to a member, and preserve completion history without duplicating linked inventory state. | Planned — iteration 2 |

### Local assistant and retrieval

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-AST-01 | Answer common inventory questions from local structured data without loading a model. | Quantity, status, location, category, low/out, forecast, cadence, and count tests pass while the runtime factory remains unused. | Current iteration |
| FR-AST-02 | Retrieve relevant records locally for ambiguous or free-form language. | Unicode-aware retrieval ranks exact primary/alternative names, categories, locations, stock facets, and token overlap; at most 12 records enter model context. | Current iteration |
| FR-AST-03 | Use the browser model only as an allowlisted query/action planner. | The model emits one schema-validated JSON plan; application code computes facts from current inventory and rejects invented items, fields, categories, IDs, and extra keys. | Current iteration |
| FR-AST-04 | Require explicit consent before the optional model download. | Deterministic queries work with the model off; no runtime or model request begins until “Enable local assistant” is activated. | Shipped |
| FR-AST-05 | Require visible confirmation before any model-interpreted mutation. | Rename, alias, and category changes render current/proposed values and apply only after “Confirm change”; cancel performs no write. | Shipped |
| FR-AST-06 | Explain answer provenance and graceful degradation. | Answers identify local inventory as their source; model-routed answers report retrieved-record count; storage/runtime errors leave deterministic queries available. | Current iteration |

### Notifications

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-NTF-01 | Notify members about low stock and predicted run-out according to preferences. | A member can opt in/out by rule/channel, set quiet hours, and receives one deduplicated notification per rule occurrence. | Planned — iteration 2 |
| FR-NTF-02 | Keep notification storage bounded. | The inbox retains at most 50 entries or 14 days; delivery deduplication expires after seven days; delivered push payloads and attempts are not permanent audit records. | Planned — iteration 2 |
| FR-NTF-03 | Support installable-PWA Web Push with recoverable subscriptions. | Permission is requested only after user intent; invalid endpoints are retired; notification links open the relevant Home OS entity. | Planned — iteration 2 |

### Household contacts and documents

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-HOM-01 | Manage rooms, storage spaces, and shared-space metadata. | Authorized members can create/archive spaces and inventory can reference stable space IDs while retaining readable labels offline. | Planned — iteration 3 |
| FR-CON-01 | Manage important landlord, maintenance, building, utility, medical, and emergency contacts. | Contacts support multiple labels/channels, household scope, search, archive, audit, and one-tap call/message where the browser permits. | Planned — iteration 4 |
| FR-DOC-01 | Store household document metadata and protected attachments. | D1 stores metadata; R2 stores files; signed/authorized retrieval enforces household access; leases, warranties, manuals, and receipts are searchable. | Planned — iteration 4 |
| FR-DOC-02 | Track document lifecycle and reminders. | Expiry/renewal dates can produce reminders; replacement/archive creates audit events; attachment contents never enter audit deltas. | Planned — iteration 4 |

### Shared expenses

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-MNY-01 | Record shared expenses with payer, participants, currency, date, category, notes, and receipt. | Equal, exact, percentage, and share-based splits sum exactly using integer minor units and reject invalid allocations. | Planned — iteration 5 |
| FR-MNY-02 | Calculate balances and simplify settlements without changing the ledger. | Balances equal the sum of immutable expense/settlement entries; simplification is a derived suggestion and never rewrites history. | Planned — iteration 5 |
| FR-MNY-03 | Record settlements, corrections, recurring bills, and exports. | Settlements/corrections append events, recurring instances are idempotent, and CSV/JSON exports reconcile to displayed balances. | Planned — iteration 5 |

### Chores, maintenance, calendar, and automation

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-TSK-01 | Create and assign one-off or recurring chores. | Recurrence is timezone-safe; completions are durable; reassignment and skipped occurrences are auditable. | Planned — iteration 6 |
| FR-MNT-01 | Track appliances, repairs, providers, warranties, and maintenance schedules. | Upcoming/overdue maintenance is derived from schedules and completion history and can link contacts/documents. | Planned — iteration 6 |
| FR-CAL-01 | Present household events, renewals, bills, chores, and maintenance on one timeline. | Entries retain source-module identity, timezone, recurrence, and deep links; duplicated external events are deduplicated. | Planned — iteration 7 |
| FR-AUT-01 | Let members define conditions that propose or perform bounded actions. | Every rule has an owner, scope, enabled state, execution history, idempotency key, and approval mode; destructive/financial actions require approval. | Planned — iteration 7 |

### MCP and external connectors

| ID | Requirement | Acceptance | Release state |
|---|---|---|---|
| FR-MCP-01 | Expose authenticated, household-scoped read tools/resources through Streamable HTTP MCP. | Unauthorized requests return 401; authorized initialization and inventory/summary/activity reads succeed without direct SQL access. | Shipped |
| FR-MCP-02 | Expose write tools only through authorized application commands. | Each write scope is separately grantable; idempotency, expected versions, confirmation semantics, and audit metadata match PWA commands. | Planned with owning modules |
| FR-EXT-01 | Import/export and external connectors are separately authorized and revocable. | Each connector exposes requested scopes and last sync; revocation stops access; inbound records use idempotent external IDs. | Planned — iteration 8 |

## Non-functional requirements

| ID | Quality | Requirement and acceptance measure | Release state |
|---|---|---|---|
| NFR-AVL-01 | Availability | `/healthz` proves process health and `/readyz` proves D1 access; a D1/API outage does not prevent cached inventory reads or supported local commands. | Shipped |
| NFR-OFF-01 | Offline | After one successful load, the app shell and cached inventory open offline; supported inventory commands queue locally; deterministic assistant queries continue without model/network. | Shipped; assistant coverage expanded current iteration |
| NFR-PERF-01 | Query performance | Deterministic query and retrieval code handles 1,000 inventory records without network access and bounds combined model context to 3,800 UTF-8 bytes. | Current iteration |
| NFR-PERF-02 | Interface performance | Model loading/generation occurs in a worker and does not block React rendering; every long operation exposes progress or an `aria-live` status. | Shipped |
| NFR-STOR-01 | Model storage | Before a 105 MB model download, estimate quota, reserve at least 32 MiB or 25% headroom, request persistent storage when supported, and fail recoverably when known capacity is insufficient. | Current iteration |
| NFR-STOR-02 | Ephemeral bounds | Local activity is limited to 30 days or 2,000 events; notification inbox/deduplication obeys FR-NTF-02; prompts, retrieved context, model output, and delivery attempts are not durable product records. | Platform policy shipped; pruning/notifications planned — iteration 2 |
| NFR-PRIV-01 | AI privacy | Inventory, prompts, retrieved evidence, and model output are never sent to a hosted inference API; the only model network request is the consented, revision-pinned weight download. | Shipped |
| NFR-SEC-01 | Secrets | API/MCP credentials exist only in Worker secrets, OS keychain, or ignored local vars; logs, audit, client bundles, Git history, and error envelopes contain no credentials. | Shipped |
| NFR-SAFE-01 | Model safety | Model output cannot directly mutate or author facts; plans are allowlisted and validated; accepted mutations require visible confirmation. | Current iteration |
| NFR-INT-01 | Integrity | Domain mutations are validated, idempotent, optimistic-concurrency checked, and atomically commit authoritative projection, operation result, durable event, and audit delta where applicable. | Shipped for inventory |
| NFR-A11Y-01 | Accessibility | All workflows are keyboard operable, dialogs trap/restore focus, controls have accessible names, status/errors use appropriate live semantics, and WCAG 2.2 AA contrast is the design target. | Shipped for current UI; regression-tested each iteration |
| NFR-COMP-01 | Compatibility | Current Chromium, Firefox, and Safari can use deterministic/offline behavior; WebGPU is an enhancement and WebAssembly is the model fallback. | Shipped |
| NFR-OBS-01 | Observability | Worker exceptions and request outcomes are observable without logging household payloads or secrets; health, readiness, sync conflicts, and deployment versions are distinguishable. | Shipped |
| NFR-MNT-01 | Maintainability | Module boundaries follow product domains; HTTP/MCP adapters call application services; TypeScript strict checks, lint, tests, build, and real-stack smoke are required release gates. | Shipped |
| NFR-REC-01 | Recovery | D1 migrations are forward-only and reproducible; exports/backups are documented; archive/restore and idempotent replay recover ordinary mistakes/interruption. | Shipped for inventory |
| NFR-COST-01 | Cost | The personal release must operate within Cloudflare free allocations under household-scale use; new paid services require a measured capacity need and an explicit documented decision. | Shipped policy |

## Traceability

| Requirement group | Primary implementation | Verification |
|---|---|---|
| FR-PLT, NFR-AVL, NFR-INT | `apps/worker/src`, `apps/worker/migrations`, `apps/web/src/offline` | Worker API/sync/audit tests; web offline tests; `scripts/smoke.mjs` |
| FR-INV, FR-SHP-01 | `apps/worker/src/inventory`, `apps/web/src/components`, `apps/web/src/offline` | inventory service/API tests; inventory app and sync tests |
| FR-AST, NFR-PERF-01, NFR-STOR-01, NFR-SAFE-01 | `apps/web/src/lib/assistant-retrieval.ts`, `inventory-assistant.ts`, `browser-assistant.ts`, assistant UI | retrieval, assistant parser/runtime, and component suites |
| FR-MCP, NFR-SEC | `apps/worker/src/mcp`, Worker secrets | MCP route tests and production unauthorized/authorized smoke |
| Planned module groups | `docs/product-architecture.md` iteration boundaries | Each owning iteration adds domain, adapter, offline, authorization, audit, and acceptance tests before status changes |

Release verification is `npm test && npm run lint && npm run build && npm run smoke`, followed by production health/readiness/API/MCP checks. A requirement moves to **Shipped** only in the same commit series that contains its passing acceptance evidence.
