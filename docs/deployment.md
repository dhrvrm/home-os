# Deployment

This project intentionally separates the static PWA from the stateful Go API.

## Local development

Start the complete local stack:

```bash
make dev
```

The defaults are `http://localhost:8080` for the API and `http://localhost:3100` for the web app. The local web server proxies `/api`, `/healthz`, and `/readyz` to the API. Copy `.env.example` values into your shell or local environment when changing addresses or allowed origins.

Before deploying, run the isolated real-stack check:

```bash
make smoke
```

## Free practical setup

The lowest-cost deployment that preserves the requested Go and SQLite stack is:

1. Publish `apps/web/out` with Cloudflare Workers Static Assets.
2. Run the Go binary on an always-on laptop, mini PC, Raspberry Pi, NAS, or other home server.
3. Keep the SQLite file on that machine's persistent disk.
4. Protect the API with an authentication layer before exposing it beyond a trusted network.
5. Expose only the protected API through Cloudflare Tunnel and set `NEXT_PUBLIC_API_URL` to that HTTPS hostname before building the PWA.

Cloudflare Tunnel is available on all plans and creates an outbound connection, so the home network does not need an inbound port opened. A tunnel is transport, not application authentication; do not publish this MVP API directly to the Internet without an access policy or an API authentication feature. The home machine must remain online for inventory changes to work.

Build and publish the PWA after authenticating Wrangler:

```bash
NEXT_PUBLIC_API_URL=https://api.example.com npm run build --workspace @home-os/web
npm run deploy --workspace @home-os/web
```

Cloudflare now recommends Workers for new projects. Static asset requests are free and unlimited; the Free plan currently allows 20,000 files per Worker version and a 25 MiB maximum per asset. These are current platform terms, not a permanent promise. See the official [Pages migration guidance](https://developers.cloudflare.com/pages/migrations/), [Static Assets documentation](https://developers.cloudflare.com/workers/static-assets/), and [Static Assets limits](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## Run the API on persistent storage

Build the server:

```bash
make build
```

Run it with explicit production settings:

```bash
HOMEOS_ADDR=:8080 \
HOMEOS_DB_PATH=/var/lib/home-os/home-os.db \
HOMEOS_ALLOWED_ORIGINS=https://home.example.com \
./bin/home-os-api
```

The process user must be able to create and update the database directory. If using a container, mount `/var/lib/home-os` from a persistent host volume. A small VPS is simpler than home hosting but generally is not permanently free.

Back up a live database with SQLite's online backup command:

```bash
mkdir -p backups
sqlite3 /var/lib/home-os/home-os.db ".backup 'backups/home-os.db'"
```

Copy the backup off the API host and test a restore periodically.

## Fully Cloudflare-native alternative

A future free-tier Cloudflare-only deployment would replace the Go executable and local SQLite adapter with a TypeScript Worker API plus D1. D1's Free plan currently includes daily read and write quotas, while Worker script requests have their own Free plan quota; confirm the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) before relying on them.

This is a different persistence adapter and runtime, not a way to upload a writable SQLite file to Workers. Cloudflare supports Go through WebAssembly rather than as a first-class Worker language, and a Go-on-Wasm D1 bridge would add operational complexity without helping the household use case. The official [Workers language guide](https://developers.cloudflare.com/workers/languages/) documents that boundary.

Cloudflare Containers can run a Go server, but they currently require the Workers Paid plan. See the official [Containers documentation](https://developers.cloudflare.com/containers/) and [pricing](https://developers.cloudflare.com/containers/pricing/).
