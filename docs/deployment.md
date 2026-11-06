# Cloudflare deployment and operations

Home OS deploys as one Cloudflare Worker. Workers Static Assets serves the exported Next.js PWA; Hono serves `/api/v1`, health checks, synchronization, and `/mcp`; D1 stores authoritative household state and audit history. There is no separately hosted backend or database process.

## Services and free-tier shape

- **Workers Static Assets:** PWA shell and bundled Wllama runtimes.
- **Worker:** API, sync, and stateless MCP protocol handling.
- **D1:** inventory projections, immutable stock events, idempotency records, and audit events.
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

MCP uses a separate high-entropy credential. Store the production value only as a Worker secret:

```bash
source scripts/cloudflare-env.zsh
openssl rand -base64 36 | tr -d '\n' | npx wrangler secret put HOMEOS_MCP_TOKEN --config apps/worker/wrangler.jsonc
```

Save the generated MCP credential in a password manager before piping it if a client will need it later. For local development, copy `apps/worker/.dev.vars.example` to the ignored `apps/worker/.dev.vars` and replace its placeholder.

## First deployment

The email/password release adds migration `0005_auth.sql`. Apply migrations before deploying it. Previously anonymous household APIs now return 401 until the owner is established and signs in. Existing inventory, expense participants, and audit attribution retain the stable `local-owner` member identity.

Create two independent, high-entropy secrets with a password manager and store them as Worker secrets without putting their values in command arguments or shell history:

```bash
source scripts/cloudflare-env.zsh
npx wrangler secret put HOMEOS_SETUP_TOKEN --config apps/worker/wrangler.jsonc
npx wrangler secret put HOMEOS_PASSWORD_PEPPER --config apps/worker/wrangler.jsonc
```

`HOMEOS_SETUP_TOKEN` is the first-owner setup code. `HOMEOS_PASSWORD_PEPPER` must contain at least 32 characters and must be backed up separately from D1. Losing or changing it makes stored password verifiers unusable; do not rotate it as if it were a session token. Keep both secrets out of source, logs, and browser storage. Setup is disabled without valid deployment configuration. There is no public signup or email-delivery dependency.

Visit the deployed app, enter the setup code, and choose the owner's email/password. Add other accounts through Members. Owners can edit member details/roles, set a password for existing members, reset other members' passwords, deactivate/reactivate accounts, and change their own password in Account. The final active owner cannot be demoted or deactivated. Deactivation and password reset revoke sessions while preserving member IDs and household history. If the only owner loses their password, recovery needs a deployment operator; no email reset service is configured.

Password verifiers use per-account random salts and an independent HMAC pepper before PBKDF2-SHA256. The 100,000-iteration setting respects Cloudflare's production PBKDF2 ceiling; it is below the general OWASP PBKDF2 recommendation. The pepper is therefore required rather than optional. Login attempts are bounded by email and source address. Verify request CPU against the actual Worker plan before assuming free-tier compatibility.

Sessions use random opaque credentials in HttpOnly, SameSite=Strict cookies (Secure on HTTPS); only token hashes live in D1. Remembered sessions expire after 30 days; nonremembered sessions use a browser-session cookie and expire after 12 hours. Password changes end old sessions and issue a fresh nonremembered session. Same-origin JSON checks protect mutations. Protected writes also require `X-HomeOS-Member` matching the session, so an old tab cannot borrow a different member's new cookie; the PWA sends this automatically. Close/reopen older installed versions after this release. Cookies do not authorize MCP.

The PWA precaches a content-versioned HTML/JS/CSS/font shell and PNG icons. Authentication, API, MCP, health, and external model responses are never service-worker cached. Installation requires HTTPS outside localhost. Test installation and relaunch on the target phones; password-manager save prompts and iOS installation are browser-controlled.

Offline access uses only the last accepted unexpired identity and the device's household copy. Server revocation is enforced when the device reconnects; it cannot be observed while disconnected. An explicit online rejection locks the app without granting an offline fallback. Pending edits survive same-member reauthentication. Sign-out requires server revocation before clearing the local copy; account switching requires clearing the previous member's local work. Device-local storage is not encrypted by this change.

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
   # Anonymous household data must return HTTP 401.
   curl -s -o /dev/null -w '%{http_code}\n' https://home-os.<workers-subdomain>.workers.dev/api/v1/items
   ```

Use an MCP Inspector or client with `Authorization: Bearer <HOMEOS_MCP_TOKEN>` for `/mcp`. Opening `/mcp` in a browser is not a protocol test.

After deployment, check `/api/v1/auth/status` has `setupAvailable: true`, complete owner setup, and verify remembered login survives a browser restart, password-manager fields are recognized, anonymous API access is denied, and logout rejects the old cookie. Verify offline inventory and app-update handling on a phone. Monitor auth errors and Worker CPU without recording request bodies, passwords, cookies, pepper, or setup keys. Unexpected authenticated 401s, login 5xx, CPU-limit errors, or lost local queues require investigation. An anonymous 401 is the intended behavior and is not a rollback trigger.

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

The deployment serves one configured household with email/password member accounts and owner/member/viewer roles. The owner controls account creation; viewer accounts cannot mutate household data. MCP remains a separately authenticated read-only personal endpoint. Third-party MCP clients still require OAuth 2.1, scoped grants, revocation, and an authorization audit before broad sharing or write tools. Contacts and menu/meal-attendance modules remain subsequent work.
