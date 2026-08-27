# Cloudflare deployment and operations

Home OS deploys as one Cloudflare Worker. Workers Static Assets serves the exported Next.js PWA; Hono serves `/api/v1`, health checks, synchronization, and `/mcp`; D1 stores authoritative household state and audit history. There is no separately hosted backend or database process.

## Services and free-tier shape

- **Workers Static Assets:** PWA shell and bundled Wllama runtimes.
- **Worker:** API, sync, and stateless MCP protocol handling.
- **D1:** identities, sessions, organizations, OAuth grants, inventory projections, immutable stock events, idempotency records, and audit events.
- **Browser IndexedDB/Dexie:** local projections, recent activity, and queued writes. It is not a backup for D1.
- **Browser origin-private storage:** optional 105 MB GGUF model, downloaded only after consent and reused offline. The client checks quota with at least 32 MiB or 25% headroom and requests persistent storage when the browser supports it.

Workers and D1 have free plans with daily limits suitable for a small personal household. Confirm current limits before relying on them. Later document storage belongs in R2; notification delivery can add Cron Triggers and Queues only when that module ships.

The model file is fetched from its revision-pinned Hugging Face URL by the consenting browser. It is not uploaded with Worker Static Assets or precached by the service worker. Browser storage can still be cleared by the member or, when persistence is not granted, evicted under device pressure; deterministic assistant queries remain available without it.

## Credentials

The original Cloudflare API token is stored in macOS Keychain under service `cloudflare-api-token` and account `dhrvrm-home-os`, but it has narrower permissions than this deployment needs. Wrangler OAuth is the default. Load the non-secret account configuration without printing any credential:

```bash
source scripts/cloudflare-env.zsh
npx wrangler whoami
```

The script exports the non-secret Cloudflare account ID and leaves the OAuth session in control. Setting `HOMEOS_USE_KEYCHAIN_API_TOKEN=1` opts into the narrower Keychain token for a command that supports its scopes. Never commit the token, `.dev.vars`, or a copied shell history containing it. Rotate the API token because the original value was shared in chat.

Home OS requires one stable session-signing secret and the Google OAuth client credentials. Store them only as encrypted Worker secrets:

```bash
source scripts/cloudflare-env.zsh
openssl rand -base64 48 | npx wrangler secret put BETTER_AUTH_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

Do not rotate `BETTER_AUTH_SECRET` during an ordinary deployment because rotation invalidates sessions and tokens. MCP clients use short-lived OAuth tokens; there is no shared MCP bearer secret. For local development, copy `apps/worker/.dev.vars.example` to the ignored `apps/worker/.dev.vars` and replace its placeholders. The exact Google origins and callback URLs are in [authentication.md](authentication.md).

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

4. Set `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`, then deploy the unified Worker:

   ```bash
   npm run build --workspace @home-os/web
   npm run deploy --workspace @home-os/worker
   ```

5. Verify the deployed URL:

   ```bash
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/healthz
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/readyz
   curl -i https://home-os.<workers-subdomain>.workers.dev/api/v1/items
   curl -fsS https://home-os.<workers-subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp
   ```

The unauthenticated item request must return `401`, proving the auth gate is active. Use MCP Inspector or ChatGPT to complete OAuth and call `/mcp`; opening `/mcp` in a browser is not a protocol test. See [authentication.md](authentication.md).

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

Google identity, server-side sessions, organization membership, role checks, household isolation, and OAuth 2.1 protect the application and MCP endpoint. Access tokens are audience- and organization-bound; every request rechecks the session and current membership. The browser retains household-scoped offline projections after sign-out but does not render them without an authenticated active organization. MCP remains read-only until write scopes, confirmations, idempotency, and actor attribution are implemented end to end.

Invitation links are bearer-like until accepted and expire after 48 hours. Share them only with the intended address. Google email verification is required during acceptance. Access changes should be validated by removing a test member and confirming both `/api/v1` and MCP calls stop succeeding.
