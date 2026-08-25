# Home OS

Home OS is a shared household inventory for roommates. It tracks what is available, where it lives, how quickly it is consumed, and what needs to be bought next.

The first release includes:

- a simple 0-100 stock meter with `full`, `okay`, `low`, and `out` states
- exact quantity tracking for items that need it
- alternative names in any language, multiple categories, locations, search, and quick filters
- purchase and consumption history
- learned consumption cadence and lightweight run-out forecasts
- an installable, offline-capable PWA

Simple items start at the level you choose. Each **Use** action subtracts 25 points and **Restock** returns the item to 100. After two consumption events, Home OS begins showing the item's typical usage interval.

Each item has one primary display name and can also have alternative names, such as a Hindi household name or a common brand name. Search matches every name and every category. An item may belong to several categories, and appears under each matching category filter.

## Stack

- Go API using the standard HTTP library
- SQLite single-file persistence
- Next.js static SPA with TypeScript
- Cloudflare Workers Static Assets deployment for the PWA

## Run locally

Requirements: Go 1.24+, Node.js 22+, and npm 11+.

```bash
npm install
go work sync
make dev-api
```

In another terminal:

```bash
make dev-web
```

Open `http://localhost:3000`. Runtime data is stored in `apps/api/data/home-os.db` unless `HOMEOS_DB_PATH` is set.

## Verify

```bash
make test
make lint
make build
```

## Deploy

`npm run deploy --workspace @home-os/web` publishes the static PWA to Cloudflare Workers Static Assets. The Go API requires a host with a persistent volume; see [deployment guidance](docs/deployment.md) for the free and paid options.

## Project structure

```text
apps/api   Go domain, SQLite adapter, and HTTP transport
apps/web   Next.js SPA, PWA shell, and Worker assets config
docs       Architecture and deployment decisions
```

## License

MIT
