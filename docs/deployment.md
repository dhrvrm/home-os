# Cloudflare deployment and operations

Home OS deploys as one Cloudflare Worker. Workers Static Assets serves the exported Next.js PWA; Hono serves `/api/v1`, health checks, synchronization, and `/mcp`; D1 stores authoritative household state and audit history. There is no separately hosted backend or database process.

## Services and free-tier shape

- **Workers Static Assets:** PWA shell and bundled Wllama runtimes.
- **Worker:** API, sync, and stateless MCP protocol handling.
- **D1:** inventory projections, immutable stock events, idempotency records, and audit events.
- **Browser IndexedDB/Dexie:** local projections, recent activity, and queued writes. It is not a backup for D1.
- **Browser origin-private storage:** optional 105 MB GGUF model, downloaded only after consent.

Workers and D1 have free plans with daily limits suitable for a small personal household. Confirm current limits before relying on them. Later document storage belongs in R2; notification delivery can add Cron Triggers and Queues only when that module ships.

## Credentials

The original Cloudflare API token is stored in macOS Keychain under service `cloudflare-api-token` and account `dhrvrm-home-os`, but it has narrower permissions than this deployment needs. Wrangler OAuth is the default. Load the non-secret account configuration without printing any credential:

```bash
source scripts/cloudflare-env.zsh
npx wrangler whoami
```

The script exports the non-secret Cloudflare account ID and leaves the OAuth session in control. Setting `HOMEOS_USE_KEYCHAIN_API_TOKEN=1` opts into the narrower Keychain token for a command that supports its scopes. Never commit the token, `.dev.vars`, or a copied shell history containing it. Rotate the API token because the original value was shared in chat.

MCP uses a separate high-entropy credential. Store the production value only as a Worker secret:

```bash
source scripts/cloudflare-env.zsh
openssl rand -base64 36 | tr -d '\n' | npx wrangler secret put HOMEOS_MCP_TOKEN --config apps/worker/wrangler.jsonc
```

Save the generated MCP credential in a password manager before piping it if a client will need it later. For local development, copy `apps/worker/.dev.vars.example` to the ignored `apps/worker/.dev.vars` and replace its placeholder.

## First deployment

1. Install and verify everything:

   ```bash
   npm ci
   npm test
   npm run lint
   npm run build
   npm run smoke
   ```

2. Create D1 once and place its returned `database_id` in `apps/worker/wrangler.jsonc`:

   ```bash
   source scripts/cloudflare-env.zsh
   npx wrangler d1 create home-os --config apps/worker/wrangler.jsonc
   ```

3. Apply all remote migrations:

   ```bash
   npx wrangler d1 migrations apply home-os --remote --config apps/worker/wrangler.jsonc
   ```

4. Set `HOMEOS_MCP_TOKEN`, then deploy the unified Worker:

   ```bash
   npm run build --workspace @home-os/web
   npm run deploy --workspace @home-os/worker
   ```

5. Verify the deployed URL:

   ```bash
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/healthz
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/readyz
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/api/v1/items
   ```

Use an MCP Inspector or client with `Authorization: Bearer <HOMEOS_MCP_TOKEN>` for `/mcp`. Opening `/mcp` in a browser is not a protocol test.

## Local stack

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run dev
```

The local URL is `http://localhost:8787`. Wrangler keeps local D1 state in its ignored `.wrangler` directory. The launcher applies pending local migrations before it starts the Worker.

## CI and release order

CI runs both test suites, TypeScript/ESLint checks, the isolated real-Worker smoke test, and both production builds. A release should deploy only after those gates pass. Apply D1 migrations before code that requires them; migrations are forward-only and receive a new numbered SQL file rather than editing an applied file.

## Backup and recovery

Create periodic D1 exports and keep copies outside Cloudflare:

```bash
source scripts/cloudflare-env.zsh
npx wrangler d1 export home-os --remote --output home-os-backup.sql --config apps/worker/wrangler.jsonc
```

The PWA JSON export is useful for household portability but is not a full audit/idempotency backup. Test restoration into a separate D1 database before depending on a backup procedure.

## Security boundary

The personal deployment uses one household and one MCP Bearer secret. This is adequate only for a controlled personal endpoint. Before roommate accounts or third-party clients are invited, add identity, household membership, role checks, OAuth 2.1 for MCP, scoped grants, token revocation, and an authorization audit. MCP remains read-only until write scopes, confirmations, idempotency, and actor attribution are implemented end to end.
