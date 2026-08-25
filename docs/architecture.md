# Architecture

Home OS starts as one small system with two deployable nodes: a static web client and an inventory API. The HTTP relation between them is deliberately narrow so the UI, persistence, and future household modules can change independently.

## Runtime shape

```text
Next.js static PWA
       |
       | JSON over /api/v1
       v
Go HTTP API
       |
       | repository interface
       v
SQLite file
```

The web application is a client-side Next.js export. It has no Next.js server dependency and can be served as ordinary static assets. Its service worker caches the application shell and same-origin static files; API calls remain network-first so stale inventory is never presented as current data.

The Go application owns validation, stock transitions, and forecasting. HTTP handlers translate requests into domain operations. The SQLite package implements the domain repository interface, so persistence can be replaced without moving business rules into the transport layer.

## Inventory model

An item uses one of two tracking modes:

- `simple` records a 0-100 estimate and derives household-friendly states: `out` at 0, `low` from 1-25, `okay` from 26-75, and `full` from 76-100. A normal consumption action removes 25 percentage points and restocking returns it to 100.
- `exact` records a numeric quantity and unit, plus a minimum quantity used for low-stock state.

Every stock change is an event. After two consumption events, Home OS derives a typical interval between uses for either tracking mode. Exact consumption events also provide the history used to estimate average daily usage and a likely run-out date. Cadence and forecast confidence increase with the amount and span of consumption history; both are guidance, not guarantees.

An item has one primary `name`, zero or more language-agnostic `alternativeNames`, and one or more `categories`. Alternative names make household terms such as Hindi names searchable without changing the primary display identity. Categories are ordered; the first value is also exposed as singular `category` for compatibility with v1 clients. The service trims and case-insensitively deduplicates both collections, defaults an empty category list to `Other`, and allows up to eight alternative names and nine categories.

## API contract

The current version is namespaced under `/api/v1`:

- `GET /healthz`
- `GET /api/v1/items?q=&category=&stockLevel=`
- `POST /api/v1/items`
- `POST /api/v1/items/{id}/events`

Responses use one envelope:

```json
{"data": {}, "error": null}
```

Errors replace `data` with `null` and include a stable code plus a readable message. Request bodies are size-limited, writes are validated in the domain service, and an inventory event plus its resulting item state is committed in one SQLite transaction.

Item responses include both `categories` and the compatibility `category` projection. New clients should send `categories` and `alternativeNames`; older requests that send only `category` remain valid.

## Persistence and concurrency

SQLite is configured with foreign keys, WAL mode, a busy timeout, and one database connection. The Go service serializes stock mutations so concurrent roommate actions cannot overwrite one another between the domain read and database write. That is a good fit for a household-sized, single-process write workload and avoids pretending a single file is a distributed database. The database file must live on durable local or mounted storage.

Opening an older database adds the percentage columns in place and maps existing simple states to percentages (`full=100`, `okay=50`, `low=25`, `out=0`). It also creates normalized child tables for alternative names and category memberships, then idempotently backfills each legacy singular category as the item's first category. Back up the database before deploying a new binary even though the migrations preserve existing item and event rows.

Cloudflare Workers do not provide a durable local filesystem. Workers Static Assets can host the PWA, but the Go API and SQLite file must run elsewhere. A future Cloudflare-native adapter would consist of a Worker API and D1 repository behind the same `/api/v1` contract. It should be added only when its operational benefit justifies maintaining a second runtime.

## Growth boundaries

Contacts, shared expenses, chores, and MCP integrations are not folded into the inventory package. Each should become a separate domain package with its own models and repository port, while household identity and membership become shared concepts only when a second subsystem actually needs them.
