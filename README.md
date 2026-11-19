# Home OS

Home OS is an offline-first shared operating system for roommates. It includes inventory, household accounts, recurring expense rules, recipes, a meal calendar with attendance, shared contacts, and meal reminder notifications. Documents, a payment ledger, chores, and general automations remain on the roadmap.

The canonical [functional and non-functional requirements](docs/requirements.md) distinguish shipped behavior from the planned household modules.

Inventory currently supports:

- simple 0–100 stock levels and exact quantity tracking;
- alternative names in any language and multiple categories;
- locations, search, filters, shopping state, archive, restore, and JSON export;
- immutable consumption history, cadence, and run-out forecasts;
- local-first edits in Dexie with an idempotent outbox and conflict detection;
- a private in-browser assistant with deterministic queries and an optional SmolLM2 135M model;
- personal MCP connections that use the same roles and household commands as the app;
- one installable PWA and API deployed as a Cloudflare Worker with D1.

Members sign in with email and password. Owners create member accounts, appoint additional owners, change roles, and reset or deactivate access. At least one active owner who can sign in must remain. Password managers can save credentials; Home OS stores no browser password. Sign-in has no automatic server expiry. Account lists browser sessions and connected assistants so you can end access explicitly.

The full information architecture and preserved roadmap are in [docs/product-architecture.md](docs/product-architecture.md).

## Architecture

```text
Next.js static PWA
  └─ Dexie projections + transactional outbox
       └─ Hono Worker /api/v1 + /mcp
            └─ D1 authoritative inventory + audit history
```

The browser applies supported commands locally before the network is used. Startup, reconnect, and manual sync send queued operations to D1. Operation IDs make retries idempotent; entity versions turn concurrent roommate edits into visible conflicts instead of silent overwrites.

### Connect an assistant

Add **`https://home.dhruvverma.dev/mcp`** as a remote Streamable HTTP MCP server in a client that supports OAuth discovery and PKCE. Sign in to Home OS, review the client and destination, then approve. Every active account can connect. Old clients using the shared operator token must reconnect personally; that token no longer grants access.

| Role | Shared household facts | Personal controls | Household access |
|---|---|---|---|
| Owner | Read and maintain; answer own meal attendance | Own reminders, sessions, and connections | Manage members and revoke household grants |
| Member | Read and maintain; answer own meal attendance | Own reminders, sessions, and connections | Own access only |
| Viewer | Read | Own reminders, sessions, and connections | Own access only |

MCP covers inventory and history, activity, recurring expense rules, recipes, meals, attendance, contacts, personal notifications, and permitted member/access controls. Commands use operation IDs and observed versions, so retries preserve one accepted change and stale edits return conflicts. Lists and exports include continuation cursors.

A connection stays within both the person's current role and the role approved at consent. Demotion takes effect immediately; promotion requires reconnecting for broader access. Access tokens last fifteen minutes and renew through a continuing refresh grant with no automatic expiry. Revoke connections in Account or through the permitted MCP connection command. Optional RFC7009 token revocation is not exposed.

Passwords, account setup, OAuth approval, and native push enrollment require a person in the app. Their tools return `requires_user_action` with the relevant Home OS form; they do not accept passwords or claim those actions are complete.

## Meals, contacts, and reminders

Create reusable recipes with ingredients and instructions, then add one or several dishes to a meal for tomorrow or the coming week. Set its cooking time in the household timezone and a reminder lead time. Owners and members answer for themselves: yes, no, or pending. Changing the dishes or cooking time asks everyone to confirm again; editing notes preserves answers. Planning a meal does not consume inventory. Ingredient availability is guidance: exact quantities with matching units can be checked, while unlinked or approximate stock remains uncertain.

Contacts keep shared names, roles, phone numbers, email, addresses, labels, and notes, with search and archive/restore. Contact records do not grant login access.

Notifications shows unanswered meal reminders and personal preferences. Choose **Enable on this device** to permit Web Push after deployment has sender keys configured. On iPhone/iPad, first install the app through Safari’s Share → Add to Home Screen. Keep the device signed in: sign-out, session revocation, password replacement, and deactivation stop delivery for that grant. Native push subscriptions can expire independently. Browser permission alone does not mean the device is registered. Notification delivery depends on the browser/OS and network; opening a reminder always checks current access.

Menu, recipes, contacts, and inbox preserve the last accepted reads offline. Their changes and attendance responses require a connection; only supported inventory changes queue offline.

## Browser assistant

**Ask Home** answers counts, quantities, status, locations, categories, low/out stock, forecasts, and cadence directly from local inventory without a model. For ambiguous language and rename/alias/category requests, local Unicode-aware retrieval selects at most 12 relevant records and the optional SmolLM2 135M model emits only an allowlisted query/action plan. Application code verifies that plan against current inventory; the model never authors facts or writes directly.

The model is an explicit, optional download of about 105 MB into origin-private browser storage. Before downloading, Home OS estimates quota, keeps safety headroom, and requests persistent storage when supported. Wllama runs in a worker with WebGPU or WebAssembly and reuses the cached model offline. Prompts, retrieved context, and outputs are ephemeral, and every proposed mutation still requires confirmation.

## Local development

Requirements: Node.js 22.18+ and npm 10+.

```bash
npm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm run dev
```

Open `http://localhost:8787`. The launcher builds the static PWA, applies pending local D1 migrations, then Wrangler serves the app, API, MCP endpoint, and database from one origin.

Replace the example secrets before use: `HOMEOS_SETUP_TOKEN` is the private first-owner setup code, and `HOMEOS_PASSWORD_PEPPER` is an independent random secret of at least 32 characters. Open the app and create the owner with the setup code, then add household members from Members. There is no public account registration.

Install from Account or the browser menu (Safari: Share → Add to Home Screen). After the first connected visit, the installed shell and saved inventory reopen offline within the last admitted member's boundary. First sign-in, account/expense/member changes, and sign-out need a connection. Explicit server rejection locks saved work until access is restored. Account switching or confirmed sign-out clears the device's household copy; queued edits require an explicit discard decision. PWA updates wait for a deliberate reload and cannot apply while edits remain queued. An older installed shell can open `/api/app` to load the current app without forcing an update or discarding its queue.

Browsers cap cookie retention at 400 days; Home OS renews the cookie during coordinated online status checks. Clearing storage or a device/browser policy can still require sign-in. Sign-out ends that browser's grant; independently approved assistants continue. Password replacement and member deactivation end all existing browser and assistant grants.

## Verify

The HTTPS browser checks require Node.js 22.23.5 or newer Node.js 22.

```bash
npm test
npm run lint
npm run build
npm run smoke
npm run smoke:browser
npm run smoke:mcp
npm run smoke:upgrade
```

The HTTP smoke test creates isolated D1 state and exercises authentication, inventory, owners, recipe snapshots, meals, attendance, contacts, and reminder deduplication. Browser checks require Chrome locally, or Playwright Chromium with `HOMEOS_BROWSER_CHANNEL=chromium`; set `HOMEOS_SKIP_BUILD=1` after building to reuse the current static output. The MCP check uses the official client SDK and browser consent, checks role restrictions and shared domain state, and tests refresh, revocation, logout and cookie ordering. The upgrade check builds the prior release in a disposable archive, installs its real service worker, queues an offline change, then migrates the same isolated D1 and browser profile to the current app and applies an explicit PWA update. It needs Git history (`git fetch --unshallow` for a shallow clone), OpenSSL and network access to install the prior lockfile. Both HTTPS checks trust only their temporary local certificate and remove their temporary servers, profiles, keys and databases when finished.

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
