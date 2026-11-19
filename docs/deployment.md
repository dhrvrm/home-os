# Cloudflare deployment and operations

Home OS deploys as one Cloudflare Worker. Workers Static Assets serves the exported Next.js PWA; Hono serves `/api/v1`, health checks, and synchronization. The official Cloudflare OAuth provider wraps the personal `/mcp` endpoint. D1 stores authoritative household state and audit history; `OAUTH_KV` stores provider-managed client, token, and temporary consent records.

The primary app address is `https://home.dhruvverma.dev`. The Worker custom domain is declared in `apps/worker/wrangler.jsonc`; Cloudflare manages its DNS and HTTPS certificate. Use this address when installing the PWA and connecting MCP. The `workers.dev` address remains available for ordinary app and health checks; OAuth and MCP require the configured canonical origin.

## Services and free-tier shape

- **Workers Static Assets:** PWA shell and bundled Wllama runtimes.
- **Worker:** API, sync, and stateless MCP protocol handling.
- **D1:** accounts, inventory, recurring expense rules, recipes, meals/attendance, contacts, notification state, idempotency records, and audit events.
- **Workers KV (`OAUTH_KV`):** official OAuth provider state. D1 connection records remain authoritative for permission and revocation.
- **Browser IndexedDB/Dexie:** local projections, recent activity, and queued writes. It is not a backup for D1.
- **Browser origin-private storage:** optional 105 MB GGUF model, downloaded only after consent and reused offline. The client checks quota with at least 32 MiB or 25% headroom and requests persistent storage when the browser supports it.

Workers and D1 have free plans with daily limits suitable for a small personal household. Confirm current limits before relying on them. Later document storage belongs in R2; meal reminders use one every-minute Cron Trigger and native Web Push without a queue or paid provider.

The model file is fetched from its revision-pinned Hugging Face URL by the consenting browser. It is not uploaded with Worker Static Assets or precached by the service worker. Browser storage can still be cleared by the member or, when persistence is not granted, evicted under device pressure; deterministic assistant queries remain available without it.

## Credentials

On the configured Mac, the current deployment token is stored in macOS Keychain under service `home-os-deployment-token`, account `home-os`. It can manage this deployment's Workers, D1, DNS, and custom domain. Load it without printing the credential:

```bash
source scripts/cloudflare-env.zsh
npx wrangler whoami
```

The helper exports account configuration and the Keychain token. Set `HOMEOS_USE_KEYCHAIN_API_TOKEN=0` before sourcing to use an existing Wrangler OAuth session instead. Never enable shell tracing while loading secrets, or commit `.dev.vars` or copied credential output. Tokens shared in chat should be replaced.

MCP uses personal OAuth connections. `HOMEOS_MCP_TOKEN` is no longer read or accepted. An old deployment secret can remain unused for rollback; never give it to new clients. Preserve existing setup, password-pepper, and VAPID secrets when deploying. For local development, copy `apps/worker/.dev.vars.example` to the ignored `apps/worker/.dev.vars` and replace its example values.

## First deployment

The email/password release adds migration `0005_auth.sql`. Apply migrations before deploying it. Previously anonymous household APIs now return 401 until the owner is established and signs in. Existing inventory, expense participants, and audit attribution retain the stable `local-owner` member identity.

Create two independent, high-entropy secrets with a password manager and store them as Worker secrets without putting their values in command arguments or shell history:

```bash
source scripts/cloudflare-env.zsh
npx wrangler secret put HOMEOS_SETUP_TOKEN --config apps/worker/wrangler.jsonc
npx wrangler secret put HOMEOS_PASSWORD_PEPPER --config apps/worker/wrangler.jsonc
```

`HOMEOS_SETUP_TOKEN` is the first-owner setup code. `HOMEOS_PASSWORD_PEPPER` must contain at least 32 characters and must be backed up separately from D1. Losing or changing it makes stored password verifiers unusable; do not rotate it as if it were a session token. Keep both secrets out of source, logs, and browser storage. Setup is disabled without valid deployment configuration. There is no public signup or email-delivery dependency.

Visit the deployed app, enter the setup code, and choose the owner's email/password. Add other accounts through Members. Owners can edit member details/roles, set a password for existing members, reset other members' passwords, deactivate/reactivate accounts, and change their own password in Account. At least one active owner with an established login must remain; an owner profile without login access cannot be the replacement. Deactivation and password replacement revoke all pre-change browser and MCP grants while preserving member IDs and household history. Reactivation never restores those grants. If the only owner loses their password, recovery needs a deployment operator; no email reset service is configured.

Password verifiers use per-account random salts and an independent HMAC pepper before PBKDF2-SHA256. The 100,000-iteration setting respects Cloudflare's production PBKDF2 ceiling; it is below the general OWASP PBKDF2 recommendation. The pepper is therefore required rather than optional. Login attempts are bounded by email and source address. Verify request CPU against the actual Worker plan before assuming free-tier compatibility.

Sessions use random opaque credentials in HttpOnly, SameSite=Strict cookies (Secure on HTTPS); only token hashes live in D1. New sessions have no automatic server deadline and return `expiresAt: null`. Migration promotes only still-valid legacy sessions with current active accounts; expired, revoked, or stale-credential grants cannot return. Cookies use the browser's 400-day retention maximum. Ordered online status checks renew them under an origin-wide Web Lock; ordinary domain responses cannot overwrite a newer sign-in cookie. Storage clearing and browser/device policy can still require login.

Same-origin JSON checks protect mutations. Protected writes require `X-HomeOS-Member` matching the session. The current PWA also binds sign-out to its original public session ID, so a delayed old tab cannot sign out a newer grant. Sign-out ends only that browser session and its notification device. Account shows self sessions/connections, and owners can inspect and revoke household access. Cookies never authorize MCP.

The PWA precaches a content-versioned HTML/JS/CSS/font shell and PNG icons. Authentication, API, MCP, health, and external model responses are never service-worker cached. Installation requires HTTPS outside localhost. Test installation and relaunch on the target phones; password-manager save prompts and iOS installation are browser-controlled.

Offline access uses only the last accepted current identity and the device's household copy. Server revocation is enforced when the device reconnects; it cannot be observed while disconnected. An explicit online rejection locks the app without granting an offline fallback. Pending edits survive same-member reauthentication. Sign-out requires server revocation before clearing the local copy; account switching requires clearing the previous member's local work. Old transitions cannot clear a newer member's saved work. Device-local storage is not encrypted by this change.

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

3. Provision a KV namespace once if `OAUTH_KV` is not already configured, and put its returned ID in `apps/worker/wrangler.jsonc`. Then apply all remote migrations:

   ```bash
   npx wrangler kv namespace create home-os-oauth --binding OAUTH_KV --update-config=false --config apps/worker/wrangler.jsonc
   npx wrangler d1 migrations apply home-os --remote --config apps/worker/wrangler.jsonc
   ```

4. Confirm `HOMEOS_MCP_RESOURCE` is `https://home.dhruvverma.dev/mcp`, and deploy the unified Worker:

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

Use an MCP Inspector or compatible OAuth client with remote server URL `https://home.dhruvverma.dev/mcp`. Complete the browser sign-in and consent flow. Opening `/mcp` alone is not an authorized protocol test. An anonymous request must return an RFC9728 resource-metadata challenge, and the retired operator bearer must fail.

After deployment, check `/api/v1/auth/status` has `setupAvailable: true`, complete owner setup, and verify remembered login survives a browser restart, password-manager fields are recognized, anonymous API access is denied, and logout rejects the old cookie. Verify offline inventory and app-update handling on a phone. Monitor auth errors and Worker CPU without recording request bodies, passwords, cookies, pepper, or setup keys. Unexpected authenticated 401s, login 5xx, CPU-limit errors, or lost local queues require investigation. An anonymous 401 is the intended behavior and is not a rollback trigger.

## Personal MCP and continuing-access release

Back up D1 before applying `0008_continuing_access.sql` through `0011_deactivation_grants.sql`. They add session policy/public IDs, OAuth connection and consent state, protection for the last owner who can sign in, and durable connection revocation when a member leaves. They preserve the referenced session table. Migration 0008 intentionally deletes invalid grants and cascades their notification subscriptions/deliveries. Preserve the existing password pepper, setup key, and VAPID pair. Configure the persistent `OAUTH_KV` namespace before deploying the new Worker.

Before migration, export D1 to a private file outside the checkout and save aggregate baseline rows using `wrangler d1 execute home-os --remote --config apps/worker/wrangler.jsonc --json --command "<literal audit SELECT SQL>"`. The export includes authentication verifiers and push state; it does not include OAuth KV. Run these read-only queries against the previous schema:

```sql
WITH clock AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS checked_at),
grants AS (
  SELECT s.token_hash, s.member_id,
    CASE WHEN m.id IS NULL OR m.archived_at IS NOT NULL
      OR a.member_id IS NULL OR a.credential_version <> s.credential_version
      THEN 'delete-invalid'
      WHEN s.expires_at > clock.checked_at THEN 'promote-if-still-live'
      ELSE 'retain-expired' END AS outcome
  FROM auth_sessions s CROSS JOIN clock
  LEFT JOIN members m ON m.id = s.member_id
  LEFT JOIN auth_accounts a ON a.member_id = s.member_id
)
SELECT g.outcome, COUNT(DISTINCT g.token_hash) AS sessions,
  COUNT(DISTINCT n.id) AS subscriptions, COUNT(d.id) AS deliveries
FROM grants g
LEFT JOIN notification_subscriptions n ON n.session_hash = g.token_hash AND n.member_id = g.member_id
LEFT JOIN notification_deliveries d ON d.subscription_id = n.id
GROUP BY g.outcome;

SELECT h.id AS household, CASE WHEN b.household_id IS NULL THEN 0 ELSE 1 END AS bootstrapped,
  COUNT(a.member_id) AS usable_owners
FROM households h
LEFT JOIN auth_bootstrap b ON b.household_id = h.id
LEFT JOIN members m ON m.household_id = h.id AND m.role = 'owner' AND m.archived_at IS NULL
LEFT JOIN auth_accounts a ON a.member_id = m.id
WHERE h.id = 'home' GROUP BY h.id, b.household_id;
```

An empty grant result means zero sessions. The household query must return one row. A bootstrapped household needs at least one usable owner. Zero owners is expected only while first-owner setup is pending; never create that owner as a deployment fixture. If an established household has no usable owner, stop and verify an existing person's identity before operator-assisted recovery of their existing member/account. Preserve member IDs and revoked-grant history. Review the `delete-invalid` baseline as the expected irreversible cascade.

After applying migrations, verify all four migration entries, compare retained session/device counts with the baseline, and run:

```sql
SELECT name FROM d1_migrations WHERE name IN (
  '0008_continuing_access.sql','0009_mcp_connections.sql',
  '0010_usable_owner.sql','0011_deactivation_grants.sql'
) ORDER BY name;
SELECT COUNT(*) AS invalid_sessions FROM auth_sessions s
WHERE NOT EXISTS (
  SELECT 1 FROM members m JOIN auth_accounts a ON a.member_id = m.id
  WHERE m.id = s.member_id AND m.archived_at IS NULL
    AND a.credential_version = s.credential_version
);
SELECT COUNT(*) AS invalid_public_ids FROM auth_sessions
WHERE public_id IS NULL OR length(public_id) <> 32 OR public_id GLOB '*[^0-9a-f]*';
SELECT COUNT(*) AS nonpermanent_live_sessions FROM auth_sessions
WHERE permanent = 0 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');
SELECT permanent, COUNT(DISTINCT s.token_hash) AS sessions,
  COUNT(DISTINCT n.id) AS subscriptions, COUNT(d.id) AS deliveries
FROM auth_sessions s
LEFT JOIN notification_subscriptions n ON n.session_hash = s.token_hash AND n.member_id = s.member_id
LEFT JOIN notification_deliveries d ON d.subscription_id = n.id
GROUP BY permanent;
SELECT COUNT(*) AS orphan_subscriptions FROM notification_subscriptions n
WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.token_hash = n.session_hash AND s.member_id = n.member_id);
SELECT COUNT(*) AS orphan_deliveries FROM notification_deliveries d
WHERE NOT EXISTS (SELECT 1 FROM notification_subscriptions n WHERE n.id = d.subscription_id);
SELECT COUNT(*) AS departed_connections FROM mcp_connections c JOIN members m ON m.id = c.member_id
WHERE m.archived_at IS NOT NULL AND c.status IN ('active','pending');
```

Expect four migration entries and zero invalid IDs/sessions, live finite grants, orphaned children, or departed connections. Repeat the usable-owner query. Reconcile count differences caused by concurrent login, revocation, reminder pruning, or a deadline crossing during migration; unexplained loss is a stop condition.

Prefer a forward correction that retains the current access policy. A Worker-only rollback to the predecessor is partial: it ignores permanence, and login deletes sessions whose legacy timestamps have passed, cascading their device records. It also restores shared operator bearer acceptance if that secret remains configured. Do not present such a rollback as preserving continuing access. Forward-only migrations remain applied. A full database restore would lose later household writes and could resurrect subsequently revoked grants; it is not a routine rollback. Inspect recovery in a separate database, reconcile household writes and revocations, and require fresh sign-in/device enrollment where needed.

The Worker must run before static assets for `/mcp`, OAuth discovery, `/api/oauth/*`, `/api/app`, and protected API paths. Keep `global_fetch_strictly_public` enabled for Client ID Metadata Document fetches. Canonical issuer/resource values come from trusted configuration, never an incoming Host header. Ordinary fallback app/health requests still work; alternate-origin OAuth requests are refused.

Discovery is available at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. Authorization, token exchange, and dynamic registration use `/api/oauth/authorize`, `/api/oauth/token`, and `/api/oauth/register`. Token requests require form-urlencoded bodies. Modern clients may use HTTPS Client ID Metadata Documents; compatible clients may dynamically register. Consent uses the official provider's browser-binding helpers and displays the client, destination, capabilities, and any local-app caveat.

Every connection uses scope `home:access`; effective permission is the person's current role intersected with the explicitly approved role. Promotion requires reconnecting for broader access. Fifteen-minute access tokens renew through a refresh grant with no configured deadline or idle timeout. D1 admission checks apply to every request and refresh, so password replacement, deactivation, replacement consent, and accepted revocation take effect even if provider cleanup is delayed. A temporary D1 outage returns a retryable failure without revoking a healthy grant.

Connection revocation is supported in Account and through the permitted MCP revoke command. Optional RFC7009 token revocation is omitted from discovery and rejected; do not configure clients or monitoring to depend on it. Anonymous registration and consent admission are bounded, and abandoned records are cleaned through bounded lifecycle maintenance without expanding the notification cron.

Existing shared-token clients must reconnect at the canonical MCP URL. Password/account setup and native notification enrollment remain app interactions; tools return a trusted `requires_user_action` destination. Share the [current app document](https://home.dhruvverma.dev/api/app) with existing household members before cutover. The legacy installed shell cannot parse a permanent null deadline and cannot upload more than two operations at once. It may show a sign-in error or remain offline with its ordinary update control unavailable. Open that link in the same browser/profile, sign in as the same member if needed, let saved edits sync, then choose **Account → Update and reload**. Keep browser storage intact. This preserves queued and previously-sending operations without forced service-worker activation or queue deletion. Consent documents under `/api/oauth/consent` also bypass the old shell's navigation cache. Actual HTML and JSON access responses use no-store and anti-framing headers.

Release evidence must include the deployed version/SHA, public health/readiness/PWA checks, metadata/challenge checks, and local real-provider/browser verification. Use an existing controlled production identity for an authorized live flow only when one exists. Never create the household's first owner or choose their password for testing. If setup is still pending, record that live authorized verification was unavailable and leave setup to the owner.

## Meal reminders and Web Push

The household release adds additive migrations `0006_meals_contacts.sql` and `0007_notifications.sql` (use the actual filenames listed by Wrangler). Back up D1 before applying them. Existing setup, password pepper, and MCP secrets must remain intact.

Web Push needs an independent P-256 VAPID key pair. Generate the pair with a trusted Web Crypto tool: the public value is the base64url-encoded uncompressed 65-byte point, and the private value is its 32-byte scalar. Back up both in Keychain/password manager before deployment. Keep the private value out of Git, terminal output, and command arguments. Set each through Wrangler's protected input:

```bash
npx wrangler secret put HOMEOS_VAPID_PUBLIC_KEY --config apps/worker/wrangler.jsonc
npx wrangler secret put HOMEOS_VAPID_PRIVATE_KEY --config apps/worker/wrangler.jsonc
```

`HOMEOS_VAPID_SUBJECT` identifies this deployment as `https://home.dhruvverma.dev`. Changing the key pair later requires affected browsers to register again. Without a valid pair, in-app reminders still work and configuration reports push unavailable.

The `* * * * *` Cron Trigger uses UTC and runs while the app is closed. A tick scans at most eight due recipients and reserves database capacity before admitting deliveries. It attempts at most four sends, with four concurrent sends and short transport timeouts, within D1 Free’s fifty binding requests per invocation. A database batch counts as one binding request. Due delivery requires an unanswered current announcement, enabled preferences, an active eligible member, and the exact live sign-in used to register that browser. Permanent provider rejection retires the subscription; transient failures use bounded retries before cooking time. Repeated ticks create one logical reminder per announcement/member. Inbox retention is at most fifty entries or fourteen days, with separate seven-day deduplication. Cron changes can take up to fifteen minutes to propagate; inspect configured triggers after deployment.

On the device, open Notifications and choose Enable on this device. Permission requires a gesture; iOS/iPadOS requires installation to the Home Screen. Signing out, exact session revocation, password changes, and deactivation end that device grant. Native push subscriptions may expire independently of continuing browser access. Re-enable after a new sign-in when needed. The service worker asks the API for a fresh recipient verdict before showing details, and falls back to a generic visible alert when disconnected or access changed. Provider acceptance and synthetic browser checks do not establish physical-device delivery.

A local scheduled handler is available only with Wrangler's `--test-scheduled`; production exposes no public scheduler mutation endpoint. Run `npm run smoke` for real D1 deduplication and `npm run smoke:browser` for the installed shell and household interaction checks. A real phone permission/receipt check remains device-specific.

## Local stack

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run dev
```

The local URL is `http://localhost:8787`. Wrangler keeps local D1 state in its ignored `.wrangler` directory. The launcher applies pending local migrations before it starts the Worker.

## CI and release order

CI runs both test suites, TypeScript/ESLint checks, the isolated real-Worker HTTP and browser smoke tests, and both production builds. A release should deploy only after those gates pass. Apply D1 migrations before code that requires them; migrations are forward-only and receive a new numbered SQL file rather than editing an applied file.

## Backup and recovery

Create periodic D1 exports and keep copies outside Cloudflare:

```bash
source scripts/cloudflare-env.zsh
npx wrangler d1 export home-os --remote --output home-os-backup.sql --config apps/worker/wrangler.jsonc
```

The PWA JSON export is useful for household portability but is not a full audit/idempotency backup. Test restoration into a separate D1 database before depending on a backup procedure.

## Security boundary

The deployment serves one configured household with Owner, Member, and Viewer roles. Owners manage membership and household access. Owners and members maintain shared facts and answer attendance only for themselves. Viewers read shared facts and control their own notification preferences/read state, sessions, and connections. MCP uses the same action policy and domain services, with a consent ceiling and implicit actor/household. Passwords, raw tokens, proof hashes, and push receiving secrets are excluded from MCP parameters and results. Domain mutations recheck exact current authority in the acceptance transaction, including receipt replays. Access changes are audited with non-secret actor, source, client/tool, and operation metadata.

## Actual expense ledger release

Migration `0012_expense_ledger.sql` is additive. Apply it before deploying the ledger Worker; it adds no binding, secret, financial notification, inventory sync operation or automatic recurring posting. Keep the existing D1/KV identities, canonical MCP resource, setup/password-pepper/VAPID configuration and notification schedule. Do not create a production household or first-owner account for release QA. If no existing controlled identity is available, record that authenticated production verification remains unavailable; anonymous health/readiness/challenge checks alone do not prove financial acceptance.

Preflight uses the exact candidate Node22.23.5 environment and all gates: `npm test`, `npm run lint`, `npm run build`, `npm run smoke`, `npm run smoke:browser`, `npm run smoke:mcp`, `npm run smoke:upgrade`, and `npm run smoke:ledger`. Existing gates remain required. The ledger gate uses disposable local D1, TLS certificates, persistent Chrome profiles, the official personal OAuth client, a faithful deployed `8f45806` build and current assets. It leaves evidence in `test-results/ledger/`, then removes its temporary profile/archive/database and closes its processes/listeners. The separate `102af58` nullable-session fixture remains frozen. Real phone installation, virtual-keyboard behavior, push receipt and screen-reader speech still need their appropriate device checks.

Capture aggregate rows before and after migration. For SELECT results, pass SQL as one literal `--command` argument with `--json`; the installed Wrangler's `--file` execution output reports execution counts and is unsuitable as aggregate evidence. A script should use `execFile`/`spawn` argument arrays. For an operator shell, use a quoted SQL argument (no credential/session/token columns):

```sh
npx wrangler d1 execute home-os --remote --config apps/worker/wrangler.jsonc --json --command 'SELECT COUNT(*) AS inventory_items FROM inventory_items; SELECT COUNT(*) AS members FROM members; SELECT COUNT(*) AS recurring_rules FROM expense_rules; SELECT COUNT(*) AS browser_sessions FROM auth_sessions; SELECT COUNT(*) AS connections FROM mcp_connections;'
```

After migration, check the migration and financial invariants. These commands read counts/totals only; they do not create or repair financial facts:

```sh
npx wrangler d1 execute home-os --remote --config apps/worker/wrangler.jsonc --json --command "SELECT name FROM d1_migrations WHERE name='0012_expense_ledger.sql'; SELECT COUNT(*) AS ledger_entries FROM ledger_entries; SELECT COUNT(*) AS ledger_comments FROM ledger_comments; SELECT COUNT(*) AS source_identities FROM ledger_sources; SELECT COUNT(*) AS orphan_heads FROM ledger_entries h WHERE NOT EXISTS (SELECT 1 FROM ledger_revisions r WHERE r.household_id=h.household_id AND r.entry_id=h.id AND r.version=h.version);"
npx wrangler d1 execute home-os --remote --config apps/worker/wrangler.jsonc --json --command "SELECT h.household_id,h.currency,SUM(e.amount_minor) AS net_minor FROM ledger_entries h JOIN ledger_effects e ON e.household_id=h.household_id AND e.entry_id=h.id AND e.version=h.version AND e.effect_kind='snapshot' WHERE h.lifecycle='effective' GROUP BY h.household_id,h.currency; SELECT household_id,rule_id,period_start,COUNT(*) AS originals FROM ledger_sources GROUP BY household_id,rule_id,period_start HAVING COUNT(*)>1;"
```

Expect one `0012` migration row, zero orphan heads, per-household/currency net 0 and no duplicate source rows. An empty ledger returns no currency groups, rather than fabricated zero-valued records. Compare existing-domain counts with the captured baseline and explain legitimate concurrent writes. Use integer `SUM`, not floating `TOTAL`, and never aggregate all historical transition effects as current balances.

With an existing controlled member, verify one real intended household expense/payment only when already authorized as ordinary use; do not insert release fixtures. Inspect its current balance, detail/history and own operation receipt through HTTP and personal MCP, check Viewer refusal, and reconcile actual downloaded statements at one revision/scope/currency. Existing installations should open `/api/app` in the same browser/profile, preserve inventory queues/session identity, sync supported inventory work and explicitly choose **Update and reload**. Keep local storage intact. Financial cached reads reopen offline; financial writes stay disabled and reconnect never posts a retained attempt by itself.

Use forward correction for a bad accepted fact: correct, void or restore through the current-authorized ledger command, retaining its receipt/history. Resolve linked credits before voiding their original; voiding a recurring original never releases its source period. A Worker-only rollback is partial and must be checked against the migrated schema and current authority policy. A routine database restore would discard later accepted ledger facts/receipts and could resurrect revoked grants. Investigate recovery in a separate database and reconcile later writes; do not restore over live accepted money.
