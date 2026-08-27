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

## Identity and household authorization

Better Auth runs at `/api/auth` in the Worker and stores Google identities, sessions, organizations, memberships, invitations, teams, OAuth clients, grants, and signing keys in D1. The PWA is an authentication gate: a signed-in user selects or creates an organization, and the Worker maps that organization to exactly one domain household before any `/api/v1` handler runs.

The organization is the access boundary; the household is the domain-data boundary. An active session alone is insufficient. Each request must also have a live membership in the active organization. Owners and admins manage invitations, roles, members, and groups; members use household features. Removing a membership invalidates both API and MCP access on the next request.

Dexie keeps offline data after sign-out so the device can recover offline, but every projection, activity record, conflict, and outbox operation is keyed by household. Signed-out screens never render a household projection, and switching organizations starts a separately scoped inventory/sync view.

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
- `GET /api/v1/export`
- `POST /api/v1/sync`
- `GET /api/v1/activity`
- `GET /api/v1/items/{id}/activity`

Responses use one envelope:

```json
{"data": {}, "error": null}
```

Errors replace `data` with `null` and include a stable code plus a readable message. Request bodies are size-limited, writes are validated in the domain service, and an inventory event plus its resulting item state, idempotency result, and audit event are committed as one D1 batch.

Item responses include both `categories` and the compatibility `category` projection. New clients should send `categories` and `alternativeNames`; older requests that send only `category` remain valid.

## Persistence, concurrency, and audit

All entity mutations carry an operation ID and expected version. D1 stores processed operation results for idempotent replay and rejects stale writes as explicit conflicts instead of silently overwriting roommate changes. The browser retains conflicting intent for review.

Accepted commands append a household-scoped audit event with an authoritative sequence, entity, action, actor, device, source, client time, server time, operation ID, and safe field-level deltas. Audit events are immutable. Corrections are later events. Consumption events remain first-class durable history because forecasting depends on them; notifications and delivery attempts remain bounded projections.

The browser stores only recent activity. D1 retains authoritative history and supplies a sequence cursor for synchronization. Durable Objects are not required for the initial household-sized workload; optimistic versions and atomic D1 batches provide the needed behavior with fewer moving parts.

## MCP

The `/mcp` endpoint uses the current stateless Streamable HTTP transport. The first release is read-only and exposes household summary, inventory search and detail, low-stock state, consumption history, and activity. MCP uses application services rather than direct SQL, so household scope, validation, and future authorization rules cannot be bypassed.

MCP clients authenticate through OAuth 2.1 authorization code with PKCE. The Worker publishes protected-resource and authorization-server discovery, permits dynamic client registration, and issues audience-bound JWT access tokens with `inventory:read`, `activity:read`, and an immutable organization reference selected during consent. Every MCP request validates issuer, audience, expiry, scopes, session, and current membership before creating a household-scoped tool server.

## Growth boundaries

Inventory, contacts, expenses, chores, documents, notifications, and automations remain separate product modules. They share household identity, command metadata, authorization, audit, and sync infrastructure without sharing internal models. The complete information architecture and iteration order are recorded in [product architecture](product-architecture.md).
