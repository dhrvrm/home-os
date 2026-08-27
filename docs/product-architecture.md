# Home OS product architecture

Home OS is a shared operating system for a household. Inventory is the first complete module, not the final boundary of the product. Every later module uses the same household identity, offline command, synchronization, authorization, and activity-history foundations.

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

The first MCP release is read-only and exposes household summary, inventory search, item detail, low-stock state, consumption history, and household activity. Every query is household-scoped and uses the same repository and authorization rules as the PWA API.

Write tools enter in later module iterations only after their underlying application commands, permissions, idempotency, conflict handling, and audit behavior exist. Destructive or financially meaningful tools require explicit scopes and client-visible confirmation semantics.

The initial personal deployment uses a dedicated high-entropy bearer credential stored as a Cloudflare Worker secret. Multi-member or third-party MCP clients require OAuth 2.1 with audience-bound tokens and separately grantable scopes such as `home:read`, `inventory:read`, `inventory:write`, `activity:read`, `expenses:read`, and `expenses:write`.

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

Splitwise-style expenses, equal or custom shares, balances, settlements, recurring bills, receipts, and export. Financial corrections are append-only domain events with stricter audit retention.

### 6. Chores and maintenance

Assignments, recurrence, completion history, reminders, repair records, appliances, service providers, and maintenance schedules.

### 7. Calendar and automations

Household timeline, subscriptions, renewals, utility dates, rule conditions, proposed actions, approval, and automation history.

### 8. External connectors

Versioned import/export and separately authorized integrations for calendars, messaging, shopping, and financial sources. External MCP servers remain isolated connectors; they do not receive household data without explicit member authorization.

Each iteration ships working software and receives its own implementation plan. Cloudflare products are added only when their behavior is required: D1 for relational shared data, R2 for documents, Queues and Cron for notification delivery, and Durable Objects only if measured coordination requirements cannot be satisfied by optimistic D1 commands.

## Requirements and traceability

The canonical [product requirements](requirements.md) assign stable functional and non-functional IDs, measurable acceptance conditions, and an honest release state. An item moves from planned or current iteration to shipped only when its implementation, automated acceptance evidence, and operational documentation land together.
