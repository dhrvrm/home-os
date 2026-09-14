# Architecture

Home OS is an offline-first household system delivered as one Cloudflare modular monolith. Inventory is the first complete product module. Household identity, synchronization, audit history, and authorized MCP access form the platform used by later contacts, expenses, chores, documents, notification, and automation modules.

## Runtime shape

```text
Next.js PWA ── local commands ──> Dexie projections + outbox
     │                                  │
     └──────── Cloudflare Worker <──── sync
                 ├── Hono /api/v1
                 ├── authenticated /mcp
                 ├── D1 shared state and audit
                 ├── R2 documents in a later module
                 └── Queue/Cron notifications in a later module
```

The web application remains a client-side Next.js export with no Next.js server dependency. Cloudflare Workers Static Assets serves the application and model runtime. The service worker caches the application shell; it does not treat Cache Storage as a database.

Dexie stores browser-local projections, stock events, recent activity, sync state, and an outbox. A local command updates its projection and outbox atomically, so supported inventory actions never depend on current connectivity. Sync runs at startup, on visibility regain, on the browser `online` event, and by manual retry. Background Sync is an optional enhancement rather than a correctness requirement.

The Worker owns validation, stock transitions, forecasting, authorization, conflict resolution, and accepted audit history. Hono HTTP routes, the sync endpoint, and MCP tools translate external requests into the same application queries and commands. D1 is the canonical shared household state.

## Local assistant retrieval

The assistant is a hybrid deterministic/model pipeline. A pure local retrieval module ranks current inventory using Unicode-normalized primary names, alternative names, categories, locations, units, stock facets, and token overlap. It requires no vector database, embedding download, or network call and bounds model evidence to 12 records and 3,800 UTF-8 prompt bytes.

Known questions are answered directly from inventory. For ambiguous language, SmolLM2 emits only an allowlisted `find`, `inspect`, rename, alias, or category plan. The parser rejects extra fields and invented references, then application code executes reads against the complete current projection. The model cannot author displayed household facts or mutate state; writes remain visible proposals requiring confirmation.

Wllama runs inference in a worker and uses WebGPU when available with a WebAssembly fallback. The revision-pinned 105 MB model is downloaded only after consent, stored in origin-private storage, and reused offline. The client estimates available quota, reserves at least 32 MiB or 25% headroom, requests persistence where supported, and degrades to deterministic queries if storage or inference is unavailable. Prompts, retrieval results, and model output are not persisted as product data.

## Inventory model

An item uses one of two tracking modes:

- `simple` records a 0-100 estimate and derives household-friendly states: `out` at 0, `low` from 1-25, `okay` from 26-75, and `full` from 76-100. A normal consumption action removes 25 percentage points and restocking returns it to 100.
- `exact` records a numeric quantity and unit, plus a minimum quantity used for low-stock state.

Every stock change is an event. After two consumption events, Home OS derives a typical interval between uses for either tracking mode. Exact consumption events also provide the history used to estimate average daily usage and a likely run-out date. Cadence and forecast confidence increase with the amount and span of consumption history; both are guidance, not guarantees.

An item has one primary `name`, zero or more language-agnostic `alternativeNames`, and one or more `categories`. Alternative names make household terms such as Hindi names searchable without changing the primary display identity. Categories are ordered; the first value is also exposed as singular `category` for compatibility with v1 clients. The service trims and case-insensitively deduplicates both collections, defaults an empty category list to `Other`, and allows up to eight alternative names and nine categories.

## Recurring expenses

A recurring expense is a rule, not an event. It names a total, a cadence, and a split, and every member's share follows from the rule alone. Home OS does not yet record what a given period actually cost, who paid, or who owes whom: there is no ledger and no settlement, and period materialization is a later module that will build on this rule store.

Money is stored and computed exclusively in integer minor units, so a 4,500.00 rupee rent is `450000`. Each currency declares its minor unit (`INR`, `USD`, `EUR`, and `GBP` use 2; `JPY` uses 0). Share overrides are either a fixed amount in minor units or a percentage in integer basis points, where 10000 basis points is the whole total.

Shares resolve in a fixed order: fixed amounts come out of the total first, percentages are taken from the total next, and whatever remains is divided equally among the participants with no override. Rounding never loses or invents a minor unit — the shares always sum exactly to the total, and any remainder is handed to the earliest participants in the rule's own participant order, so every device resolving the same rule reaches the same answer. A rule whose overrides exceed the total, or that leaves nobody to absorb the remainder, is rejected rather than silently adjusted.

Resolved shares are derived on every read rather than stored, so storage cannot drift from the rule. A rule naming a member who has since left the household keeps resolving and is flagged as needing attention; such a member cannot be added to a rule, but a rule that already names one stays readable and revisable.

## API contract

The current version is namespaced under `/api/v1`:

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/items?q=&category=&stockLevel=&archived=`
- `POST /api/v1/items`
- `GET /api/v1/items/{id}`
- `PATCH /api/v1/items/{id}`
- `DELETE /api/v1/items/{id}`
- `POST /api/v1/items/{id}/restore`
- `GET /api/v1/items/{id}/events`
- `POST /api/v1/items/{id}/events`
- `GET /api/v1/expenses?archived=`
- `POST /api/v1/expenses`
- `GET /api/v1/expenses/{id}`
- `PATCH /api/v1/expenses/{id}`
- `DELETE /api/v1/expenses/{id}`
- `POST /api/v1/expenses/{id}/restore`
- `GET /api/v1/export`
- `POST /api/v1/sync`
- `GET /api/v1/activity`
- `GET /api/v1/items/{id}/activity`

Responses use one envelope:

```json
{"data": {}, "error": null}
```

Errors replace `data` with `null` and include a stable code plus a readable message. A conflict may also carry the entity as it now stands, so a caller holding a stale version can rebase without a second request. Request bodies are size-limited, writes are validated in the domain service, and an inventory event plus its resulting item state, idempotency result, and audit event are committed as one D1 batch.

Item responses include both `categories` and the compatibility `category` projection. New clients should send `categories` and `alternativeNames`; older requests that send only `category` remain valid.

## Persistence, concurrency, and audit

All entity mutations carry an operation ID and expected version. D1 stores processed operation results for idempotent replay and rejects stale writes as explicit conflicts instead of silently overwriting roommate changes. The browser retains conflicting intent for review.

Accepted commands append a household-scoped audit event with an authoritative sequence, entity, action, actor, device, source, client time, server time, operation ID, and safe field-level deltas. Audit events are immutable. Corrections are later events. Consumption events remain first-class durable history because forecasting depends on them; notifications and delivery attempts remain bounded projections.

The browser stores only recent activity. D1 retains authoritative history and supplies a sequence cursor for synchronization. Durable Objects are not required for the initial household-sized workload; optimistic versions and atomic D1 batches provide the needed behavior with fewer moving parts.

## MCP

The `/mcp` endpoint uses the current stateless Streamable HTTP transport. The first release is read-only and exposes household summary, inventory search and detail, low-stock state, consumption history, and activity. MCP uses application services rather than direct SQL, so household scope, validation, and future authorization rules cannot be bypassed.

The personal deployment requires a dedicated Worker secret. Multi-member and third-party MCP access will use OAuth 2.1 with audience-bound access tokens and module-specific scopes before any write tools are exposed.

## Growth boundaries

Inventory, contacts, expenses, chores, documents, notifications, and automations remain separate product modules. They share household identity, command metadata, authorization, audit, and sync infrastructure without sharing internal models. The complete information architecture and iteration order are recorded in [product architecture](product-architecture.md).
