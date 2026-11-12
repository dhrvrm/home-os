# Persisted Login and PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let household members securely sign in with email and password, reopen their installed app, and retain their own offline inventory work.

**Architecture:** Keep the existing single Worker, D1 household, static Next app, and Dexie outbox. Server sessions use opaque random cookies and hashed database tokens. Browser storage holds only a bounded non-secret identity snapshot; the browser password manager owns saved credentials. No public registration: a deployment setup secret bootstraps the owner, who creates member accounts.

**Tech Stack:** Hono, D1, Web Crypto, Next/React, Dexie, Vitest, service worker.

---

### Task 1: Server identity and session admission

**Files:** `apps/worker/migrations/0005_auth.sql`, `apps/worker/src/auth/{crypto,session,routes}.ts`, `apps/worker/src/{env,index}.ts`, `apps/worker/src/http/{request-context,member-routes}.ts`, `apps/worker/src/sync/routes.ts`, `apps/worker/test/auth.test.ts`.

- [ ] Read the Designer's materialized contracts before implementation.
- [ ] Prove unauthenticated inventory requests return 401 using an integration test against the real Worker and D1. Prove setup without the deployment secret fails, a valid setup grants one owner, and repeated setup fails.
- [ ] Add salted password hashes with independent server pepper; enforce password length 12–128. Persist hashed random session tokens, absolute expiries, cookie flags, rate limits, logout revocation, and password-change revocation.
- [ ] Protect application APIs, validate mutation origins, reject viewer writes, and attribute direct and queued changes to the authenticated member. Preserve independent read-only MCP bearer admission.
- [ ] Add owner-only account creation, member metadata updates, password reset, archive/reactivation; prevent removal of the last owner and retain durable history references.
- [ ] Update existing HTTP test fixtures to authenticate through a test-only request helper; do not add a production bypass. Run `npm run test --workspace @home-os/worker` and `npm run lint --workspace @home-os/worker`.

### Task 2: Browser sign-in and household management

**Files:** `apps/web/src/lib/auth.ts`, `apps/web/src/auth/{session,auth-gate}.tsx`, `apps/web/src/components/{auth-screen,account-panel,members-view}.tsx`, `apps/web/src/components/auth.css`, `apps/web/src/app/page.tsx`, `apps/web/src/components/inventory-app.tsx`, relevant tests.

- [ ] Follow `.ai/design/persisted-login.md` and the Designer's browser access contract.
- [ ] Implement typed auth requests with same-origin cookies and no password persistence. Set semantic autocomplete fields and a keep-signed-in checkbox on real forms.
- [ ] Gate inventory rendering until session validation; allow offline reopening only from an unexpired prior identity. Lock on 401, preserve the original member's queue for reauthentication, and stop account switching from replaying another member's changes.
- [ ] Add account/password/logout and member management screens. Make non-owner controls read-only where required and surface actionable network, expiry, permission, and validation errors.
- [ ] Verify sign-in payloads, retry, expiry, offline identity, logout cleanup, cross-tab changes, and owner/member UI with focused tests.

### Task 3: Installable and recoverable PWA

**Files:** `apps/web/public/sw.js`, `apps/web/public/icons/*`, `apps/web/scripts/build-service-worker.mjs`, `apps/web/src/components/{pwa-register,pwa-controls}.tsx`, manifest, metadata, web build script, PWA tests.

- [ ] Produce correctly sized PNG icons and an Apple touch icon from the existing house mark; add manifest identity and scope.
- [ ] Generate a content-versioned shell cache including exported JS/CSS/fonts. Never cache authentication, API, MCP, health, or external model responses. Keep cache writes in event lifetime and clean only this app's old caches.
- [ ] Provide supported installation and iOS instructions, deliberate update application, and a visible block while local changes await synchronization.
- [ ] Test service-worker cache and network failure behavior, then inspect mobile and desktop browser flows.

### Task 4: Release verification and operations

**Files:** `scripts/smoke.mjs`, `.dev.vars.example`, README/deployment/requirements docs, dated sync test fixture.

- [ ] Diagnose the existing offline sync test failure before changing it. Its August activity timestamp is older than the 30-day retention window in November; freeze time to the scenario date and verify actual old-activity pruning separately.
- [ ] Extend real-Worker smoke to bootstrap/login, deny anonymous API access, exercise inventory, and prove logout invalidates the cookie.
- [ ] Document required setup and pepper secrets, member recovery, session/offline limits, and deployment order. Preserve previous contacts/menu/meal attendance requirements as subsequent work.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, `npm run smoke`; inspect browser email/password, reopen, logout/account switch, installed shell, and offline behavior. Complete simplify and code review before reporting completion.

**Acceptance:** No anonymous household API reads/writes; authenticated commands record the actual actor; passwords never enter browser application storage, logs, or audit; stale/revoked sessions fail; account switching never adopts another member's queued mutations; the exported PWA opens offline after first use and can update without discarding work.
