# Home OS

Home OS is an offline-first shared operating system for roommates. Inventory is the first complete module: it tracks what is available, where it lives, how quickly it is consumed, and what needs to be bought next. The platform is designed to grow into shopping, notifications, household members and spaces, important contacts and documents, Splitwise-style expenses, chores, maintenance, and carefully authorized automations.

The first release includes:

- a simple 0-100 stock meter with `full`, `okay`, `low`, and `out` states
- exact quantity tracking for items that need it
- alternative names in any language, multiple categories, locations, search, and quick filters
- purchase and consumption history
- edit, archive, restore, and JSON backup workflows
- a shopping view derived from low and out-of-stock items
- learned consumption cadence and lightweight run-out forecasts
- a private in-browser assistant for questions, renaming, alternative names, and categorization
- an installable, offline-capable PWA

The Cloudflare platform migration is being delivered iteratively. Its stable foundation is a Next.js PWA with Dexie for local-first data, a Hono Worker API, D1 for shared state and audit history, and an authenticated MCP endpoint that exposes only deployed Home OS capabilities. The full information architecture and preserved feature roadmap are documented in [product architecture](docs/product-architecture.md).

Simple items start at the level you choose. Each **Use** action subtracts 25 points and **Restock** returns the item to 100. After two consumption events, Home OS begins showing the item's typical usage interval.

Each item has one primary display name and can also have alternative names, such as a Hindi household name or a common brand name. Search matches every name and every category. An item may belong to several categories, and appears under each matching category filter.

## Local inventory assistant

**Ask Home** handles common inventory questions directly in the app, including counts, locations, and low/out-of-stock lists. These deterministic answers do not load an AI model.

Free-form requests can optionally use SmolLM2 135M Instruct through Wllama/llama.cpp. The first use asks for permission before downloading a 105 MB Q4 model from Hugging Face. The model is cached in the browser's origin-private storage and inference runs in Wllama's local worker using WebGPU when available or WebAssembly as a fallback. No hosted inference API receives the inventory.

Use a current Chromium, Firefox, or Safari release with WebAssembly SIMD. Home OS packages both Wllama's modern runtime and its pinned compatibility runtime, so older WebAssembly paths do not fetch executable code from a third-party CDN. Allow roughly 130 MB of free browser storage for the model and cache metadata; CPU-only generation is slower than WebGPU.

Generated output is treated as untrusted. It is parsed through an allowlist and can only propose a primary name, alternative names, or categories for an existing item. Home OS displays the exact proposal and requires confirmation before calling the metadata API. The model cannot directly mutate inventory.

The small model is intentionally limited: it is best at short, explicit requests with an exact item name, and its generated Hindi is weaker than its English. Hindi and other scripts remain fully supported for saved alternative names and deterministic item matching.

## Stack

- Go API using the standard HTTP library
- SQLite single-file persistence
- Next.js static SPA with TypeScript
- Wllama with a small GGUF model for browser-local inference
- Cloudflare Workers Static Assets deployment for the PWA

## Run locally

Requirements: Go 1.24+, Node.js 22+, and npm 11+.

```bash
npm install
go work sync
make dev
```

Open `http://localhost:3100`. The launcher starts both services, verifies their ports and readiness, and shuts both down together. The web app uses a same-origin development proxy, so it cannot silently drift to a different API port. Runtime data is stored in `apps/api/data/home-os.db` unless `HOMEOS_DB_PATH` is set.

To run the services separately, use `make dev-api` and `make dev-web`. The defaults are API port `8080` and web port `3100`.

## Verify

```bash
make test
make lint
make build
make smoke
```

`make smoke` starts an isolated real API, temporary SQLite database, and web proxy, then verifies create, edit, decimal consumption, history, archive, restore, and persistence.

## Deploy

`npm run deploy --workspace @home-os/web` publishes the static PWA to Cloudflare Workers Static Assets. The build copies the pinned 8.1 MB modern Wllama runtime and 15 MB compatibility runtime into the static export; the 105 MB model is not deployed to Cloudflare and is fetched only after consent. The Go API requires a host with a persistent volume; see [deployment guidance](docs/deployment.md) for the free and paid options.

## Project structure

```text
apps/api   Go domain, SQLite adapter, and HTTP transport
apps/web   Next.js SPA, PWA shell, and Worker assets config
docs       Architecture and deployment decisions
```

The product and license research behind the inventory decisions is recorded in [docs/research.md](docs/research.md). Home OS uses those projects as behavioral references only; no third-party application source was copied into this MIT repository.

## License

MIT
