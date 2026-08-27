# Home OS

Home OS is an offline-first shared operating system for roommates. Inventory is the first complete module; the same household, sync, audit, and MCP foundations are designed to grow into shopping and notifications, important contacts and documents, Splitwise-style expenses, chores, maintenance, and controlled automations.

Inventory currently supports:

- simple 0–100 stock levels and exact quantity tracking;
- alternative names in any language and multiple categories;
- locations, search, filters, shopping state, archive, restore, and JSON export;
- immutable consumption history, cadence, and run-out forecasts;
- local-first edits in Dexie with an idempotent outbox and conflict detection;
- a private in-browser assistant with deterministic queries and an optional SmolLM2 135M model;
- a secured, explicitly read-only MCP inventory and audit interface;
- one installable PWA and API deployed as a Cloudflare Worker with D1.

The full information architecture and preserved roadmap are in [docs/product-architecture.md](docs/product-architecture.md).

## Architecture

```text
Next.js static PWA
  └─ Dexie projections + transactional outbox
       └─ Hono Worker /api/v1 + /mcp
            └─ D1 authoritative inventory + audit history
```

The browser applies supported commands locally before the network is used. Startup, reconnect, and manual sync send queued operations to D1. Operation IDs make retries idempotent; entity versions turn concurrent roommate edits into visible conflicts instead of silent overwrites.

`/mcp` uses the current stateless MCP SDK v2 path and requires `HOMEOS_MCP_TOKEN`. Its tools can list/search inventory, fetch an item and its history, find low/out stock, and read the audit trail. No MCP write tools are exposed yet.

## Browser assistant

**Ask Home** answers common counts, locations, and low-stock questions deterministically without a model. Free-form rename and categorization requests can optionally download SmolLM2 135M Instruct (about 105 MB) into origin-private browser storage. Wllama runs it locally with WebGPU or WebAssembly; inventory is not sent to a hosted inference API. Model output is allowlisted, displayed as a proposal, and requires confirmation.

## Local development

Requirements: Node.js 22.18+ and npm 11+.

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run dev
```

Open `http://localhost:8787`. The launcher builds the static PWA, applies pending local D1 migrations, then Wrangler serves the app, API, MCP endpoint, and database from one origin.

## Verify

```bash
npm test
npm run lint
npm run build
npm run smoke
```

The smoke test creates isolated local D1 state, starts the real unified Worker, and exercises the inventory lifecycle through HTTP.

## Deploy

Cloudflare credentials are kept out of Git. On the configured Mac, the API token is read from Keychain:

```bash
source scripts/cloudflare-env.zsh
npm run deploy --workspace @home-os/worker
```

See [docs/deployment.md](docs/deployment.md) for D1 migrations, Worker secrets, remote verification, cost boundaries, and recovery. The 105 MB browser model is fetched only after consent; it is not part of the Worker upload.

## Project structure

```text
apps/web       Next.js PWA, Dexie offline store, and browser assistant
apps/worker    Hono API, D1 repositories/migrations, sync, audit, and MCP
docs           Architecture, product roadmap, research, and operations
```

Home OS is MIT licensed. Reviewed open-source projects informed behavior only; no third-party application source was copied. See [docs/research.md](docs/research.md).
