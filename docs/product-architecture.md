# Home OS product architecture

Home OS is a shared operating system for a household. The current release includes inventory, member accounts and multiple owners, recurring expense rules, recipes, menus and meal attendance, contacts, and meal reminder notifications. These modules share household identity, authorization, and activity history; supported inventory commands also work offline. The roadmap below preserves future boundaries rather than claiming they are deployed.

## Information architecture

```text
Home
├── Overview
│   ├── Needs attention
│   ├── Household status
│   └── Recent activity
├── Inventory
│   ├── Items
│   ├── Categories
│   ├── Locations
│   ├── Shopping
│   └── Consumption insights
├── Cooking
│   ├── Menu and attendance
│   └── Recipes and ingredient guidance
├── Household
│   ├── Members and roles
│   ├── Rooms and shared spaces
│   ├── Important contacts
│   └── Documents
├── Money
│   ├── Shared expenses
│   ├── Balances
│   └── Settlements
├── Tasks
│   ├── Chores
│   └── Maintenance
├── Activity
├── Automations
└── Settings
    ├── Notifications
    ├── Devices and access
    ├── Language and units
    └── Import and export
```

Navigation exposes only modules available in the deployed release. The stable hierarchy prevents new features from being forced into inventory while avoiding empty placeholder screens.

## Shared concepts

Every household-owned entity has:

- a globally unique ID generated on the client or server;
- a household ID that provides the authorization and synchronization boundary;
- an integer version for optimistic concurrency;
- creation and update timestamps;
- an optional archive timestamp when lifecycle recovery matters.

Every mutation is a command with:

- a globally unique operation ID for idempotency;
- the acting member, device, and source;
- a client timestamp and a server-confirmed timestamp;
- an expected entity version when modifying existing state;
- a typed payload validated by the owning product module.

The browser applies commands to Dexie first. The same operation is placed in the outbox in the same local transaction. The Cloudflare Worker later validates and applies it to D1, records the accepted result, appends an audit event, and returns authoritative projections and conflicts.

## Durable history and ephemeral projections

The audit trail stores meaningful accepted changes, not interface behavior. It is append-only and contains safe field-level deltas rather than full duplicated snapshots. Corrections create new events.

Consumption events, settlements, chore completions, membership changes, and document lifecycle events remain durable because product behavior or accountability depends on them. Sync attempts, page views, typing, model prompts, and delivered push messages are operational or ephemeral data and are not part of the household audit trail.

MCP-originated changes will record the member, MCP client, tool, operation ID, and resulting entity change. Operational MCP invocation diagnostics are separate and bounded. Secrets, access tokens, push endpoints, and attachment contents never enter audit payloads.

The PWA caches at most 30 days or 2,000 activity entries locally. Older audit history remains queryable from D1. Notification inbox entries are bounded to the newest 50 or 14 days. Delivery deduplication markers expire after seven days.

## MCP boundary

MCP is an authenticated interface to Home OS application services. It is not a database administration interface.

Personal OAuth authorizes the current member and records an approved role ceiling. HTTP and MCP share household commands and current-authority checks for reads, acceptance and replay. Inventory, recurring rules, cooking, contacts, notification preferences, permitted access controls and ledger operations are available according to that policy. Cookies and the retired operator bearer do not authorize MCP.

Ledger tools accept exact minor-unit intents with an operation ID and observed version where relevant. They cannot claim an actor, household, role or author. Financial corrections/voids identify retained facts; no tool executes a bank transfer.

The supported connection uses OAuth discovery, dynamic registration, PKCE, audience-bound tokens and `home:access`; current role and consent ceiling constrain each ordinary command. Password setup/reset and device push enrollment remain app interactions.

## Iteration map

### 1. Platform and complete inventory

Cloudflare Worker, Hono, D1, Dexie, offline writes, synchronization, conflicts, audit history, deployment, and read-only MCP inventory access. Inventory retains simple and exact tracking, alternative names in any language, multiple categories, locations, shopping state, consumption history, cadence, forecasting, archive, restore, export, and a private retrieval-grounded browser assistant.

### 2. Shopping and notifications

Derived and manual shopping entries, assignees, low-stock and predicted-run-out rules, bounded notification inbox, Web Push, preferences, quiet hours, and scheduled reminders using Cron and Queues.

### 3. Household

Roommates, invitations, roles, rooms, storage spaces, device sessions, and per-module permissions. Household membership becomes the shared authorization source for both HTTP and MCP.

### 4. Important contacts and documents

Landlord, maintenance, building, medical, utility, and emergency contacts; warranties, leases, manuals, receipts, and household documents. Metadata lives in D1 and encrypted or access-controlled files live in R2.

### 5. Shared expenses

Actual expenses, itemized and custom shares, balances, reported repayments, linked refunds, explicit recurring posting and statements are implemented in the current iteration described below. Receipt attachments remain planned. Financial corrections retain immutable revisions and reversing/replacement effects.

### 6. Chores and maintenance

Assignments, recurrence, completion history, reminders, repair records, appliances, service providers, and maintenance schedules.

### 7. Calendar and automations

Household timeline, subscriptions, renewals, utility dates, rule conditions, proposed actions, approval, and automation history.

### 8. External connectors

Versioned import/export and separately authorized integrations for calendars, messaging, shopping, and financial sources. External MCP servers remain isolated connectors; they do not receive household data without explicit member authorization.

Each iteration ships working software and receives its own implementation plan. Cloudflare products are added only when their behavior is required: D1 for relational shared data, R2 for documents, Queues and Cron for notification delivery, and Durable Objects only if measured coordination requirements cannot be satisfied by optimistic D1 commands.

## Requirements and traceability

The canonical [product requirements](requirements.md) assign stable functional and non-functional IDs, measurable acceptance conditions, and an honest release state. An item moves from planned or current iteration to shipped only when its implementation, automated acceptance evidence, and operational documentation land together.

## Actual financial ledger (current iteration)

`apps/worker/src/ledger` preserves accepted actual expenses, refunds and reported repayments beside the recurring catalog. `shared/ledger-money.ts` is the neutral exact allocation/calculator/formatting engine used by server and browser; it imports no Worker environment. Migration `0012_expense_ledger.sql` adds immutable revisions, allocation/effect rows, comments, source identities, current heads and household financial revision without changing existing recurring/inventory/auth/notification tables. Current heads select complete snapshot effects; historical reversal/replacement effects explain transitions and do not replace current snapshots. SQL integer `SUM` computes complete balances, independently of bounded visible pages.

Every accepted command shares the transaction with its authority/version/capacity/source guards, receipt and safe audit cause. Expense payer and beneficiary sums conserve total; credits reverse both sides within original caps; reported payments conserve sender/receiver value. Balances use contributions minus consumption plus sent minus received, grouped by currency. Deterministic cumulative-interval suggestions settle net balances without claiming a unique original debt or minimum payment count.

HTTP `/api/v1/ledger` and MCP are thin adapters:

| HTTP suffix | MCP primitives |
| --- | --- |
| `/entries`, `/entries/:id`, `/preview` | `ledger_entries_list`, `ledger_entry_get`, `ledger_preview` |
| `/expenses`, `/refunds`, `/payments` | `ledger_expense_create`, `ledger_refund_create`, `ledger_payment_create` |
| `/entries/:id` PUT; `/void`, `/restore` POST | `ledger_entry_correct`, `ledger_entry_void`, `ledger_entry_restore` |
| `/entries/:id/comments`, `/history` | `ledger_comment_add`, `ledger_comments_list`, `ledger_history_list` |
| `/balances`, `/repayments`, `/summaries` | `ledger_balances`, `ledger_repayments`, `ledger_summaries` |
| `/statements`, `/export` | `ledger_statement`, `ledger_export` |
| `/rule-postings`, `/operations/:operationId` | `ledger_rule_post`, `ledger_operation_status` |

Queries return one consistent accepted financial revision, full scoped totals and bounded rows (default 25, maximum 50). Continuation binds filters and revision; a correction requires restart. Statements are current-effective facts at generation, filtered by entered date; no historical time-travel claim. Spending excludes repayments. Export pages retain scope/revision/opening/movements/closing; complete downloads cap at 10,000 rows and 8 MiB, quote/neutralize human CSV text and preserve exact numeric decimals.

Statement continuations carry authenticated totals, the last date/entry key and prior running balance. They seek through an immutable-revision ordering index and join only current effective heads and the requested person's snapshot effects. The revision lookup runs before the range seek; changed revisions require restart without scanning movements. Complete totals are computed on the first page and remain valid only at that same revision. Same-day and later-date ranges use bounded reads, including historical corrections and voids.

The shared MCP route retains the installed SDK's 4 MiB protocol envelope. It counts streamed bytes, decodes UTF-8 strictly and parses that bounded envelope to identify top-level financial calls. Any `ledger_*` call limits the original entire frame to 64 KiB before SDK/tool dispatch, including mixed batches and escaped names. This clarifies the plan's pre-parser wording: the bounded protocol classification precedes financial admission; financial HTTP still applies 64 KiB before its JSON parser. Valid existing recipe calls retain their larger MCP allowance.

`apps/web/src/ledger` presents Entries, Balances and Recurring rules through the existing identity/navigation/focus primitives. It stores at most 20 query pages and 10 details per person, plus a distinct transactional unresolved-attempt slot. Durable exact intent precedes dispatch; response loss freezes it, authorized status/replay resolves it, and account changes use the established explicit discard boundary. No financial outbox, automatic reconnect send, new push category or bank transfer is introduced.

The application owns accepted-entry links across internal navigation. Editors own separate dirty registrations and pending invocation tokens; one editor's completion cannot clear another's guard. Losing a retained slot to another tab is distinct from losing identity. Verified acceptance remains accepted while a newer slot stays untouched. Financial cache writes preserve a newer revision and its original timestamp when an older response arrives late.
