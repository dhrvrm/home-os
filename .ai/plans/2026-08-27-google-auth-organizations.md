# Google Auth, Organizations, and MCP OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add a secure Google-authenticated application gate, organization-based household isolation, member roles and groups, and OAuth 2.1 authorization for Home OS MCP clients without breaking the offline-first inventory experience.

**Architecture:** Better Auth runs inside the existing Hono Cloudflare Worker and stores identity, sessions, organizations, memberships, teams, invitations, OAuth clients, grants, and tokens in D1. Every application request resolves the authenticated user and active organization to a domain household before touching inventory, audit, activity, or sync data. The PWA keeps data offline in Dexie but scopes every query and outbox operation by the resolved household. The MCP endpoint uses Better Auth's OAuth provider and MCP integration, binds access tokens to an organization, and rechecks membership on each request.

**Tech Stack:** Cloudflare Workers, Hono, D1, Better Auth 1.7.2, Better Auth organization/JWT plugins, `@better-auth/mcp`, `@better-auth/oauth-provider`, Next.js static export, React, Dexie, Vitest, Wrangler.

## Task 1: Add pinned authentication dependencies and generate the D1 schema

**Files:**
- Modify: `apps/worker/package.json`
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`
- Create: `apps/worker/auth-schema.config.ts`
- Create: `apps/worker/migrations/0003_auth_organizations.sql`

1. Add pinned Better Auth 1.7.2 server, MCP, OAuth-provider, and schema CLI dependencies to the relevant workspaces.
2. Add a deterministic schema-generation config using dummy local credentials only.
3. Run `npx auth@1.7.2 generate --config apps/worker/auth-schema.config.ts --output apps/worker/migrations/0003_auth_organizations.sql --yes`.
4. Extend the generated migration with the domain mapping from an auth organization to an existing household, preserving the legacy `home` household.
5. Run `npm install`, `npm run lint`, and the migration-backed Worker tests to confirm the generated schema is valid.

## Task 2: Build the Worker authentication service

**Files:**
- Modify: `apps/worker/src/env.ts`
- Create: `apps/worker/src/auth/auth.ts`
- Create: `apps/worker/src/auth/constants.ts`
- Create: `apps/worker/src/auth/households.ts`
- Create: `apps/worker/src/auth/context.ts`
- Create: `apps/worker/test/auth.test.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `apps/worker/.dev.vars.example`

1. Write tests for unauthenticated sessions, test-only email sign-up, organization creation, legacy-household claiming, and organization isolation.
2. Configure Better Auth with D1, Google, secure cookies, explicit trusted origins, organization/teams, JWT, and MCP OAuth plugins.
3. Enable email/password only behind `HOMEOS_TEST_AUTH` for deterministic tests; production exposes Google only.
4. Implement an idempotent organization-to-household resolver that first claims the unowned legacy household and otherwise creates an isolated domain household.
5. Implement request authentication that returns the user, session, active organization, membership role, and mapped household.
6. Run `npm run test --workspace @home-os/worker -- auth.test.ts` and `npm run lint --workspace @home-os/worker`.

## Task 3: Gate and scope every application API

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/http/request-context.ts`
- Modify: `apps/worker/src/http/inventory-routes.ts`
- Modify: `apps/worker/src/http/activity-routes.ts`
- Modify: `apps/worker/src/sync/routes.ts`
- Modify: `apps/worker/test/inventory-api.test.ts`
- Modify: `apps/worker/test/sync.test.ts`
- Modify: `apps/worker/test/audit.test.ts`
- Create: `apps/worker/test/auth-helpers.ts`

1. Add authenticated test helpers and change API tests to create a user and organization.
2. Add a public `/api/v1/session` context endpoint and return 401 for every protected route without a valid session.
3. Replace fixed household and actor identifiers with the resolved household and authenticated membership.
4. Reject sync operations whose embedded household differs from the authenticated household, and authoritatively attribute accepted operations to the signed-in member.
5. Add cross-organization isolation tests for reads, writes, sync, activity, and audit attribution.
6. Run all Worker tests and lint.

## Task 4: Replace the MCP bearer secret with organization-scoped OAuth

**Files:**
- Modify: `apps/worker/src/mcp/routes.ts`
- Modify: `apps/worker/src/mcp/server.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/test/mcp.test.ts`

1. Add tests for OAuth discovery, unauthenticated MCP challenges, dynamic client registration, and rejection of tokens without active organization membership.
2. Configure MCP OAuth scopes for OpenID identity plus inventory/activity read access, authorization code with PKCE, refresh tokens, and dynamic client registration for ChatGPT compatibility.
3. Bind user consent to the active organization and include a namespaced organization claim in access tokens.
4. Validate the OAuth token and recheck organization membership before constructing each MCP server context.
5. Remove the permanent shared bearer-token authentication path.
6. Run MCP and complete Worker tests.

## Task 5: Scope the offline database and sync engine by household

**Files:**
- Modify: `apps/web/src/offline/db.ts`
- Modify: `apps/web/src/offline/commands.ts`
- Modify: `apps/web/src/offline/sync.ts`
- Modify: `apps/web/src/offline/use-inventory.ts`
- Modify: `apps/web/src/offline/db.test.ts`
- Modify: `apps/web/src/offline/sync.test.ts`

1. Write tests proving one organization cannot see another organization's cached items, activity, conflicts, or pending operations.
2. Require household and actor context for local commands and live queries.
3. Filter all Dexie queries, pending outbox batches, conflicts, events, and activity by household.
4. Keep cached data for offline use while preventing it from rendering after sign-out or organization switching.
5. Run the offline web test suites and lint.

## Task 6: Add the browser auth gate and organization onboarding

**Files:**
- Create: `apps/web/src/lib/auth-client.ts`
- Create: `apps/web/src/components/auth-gate.tsx`
- Create: `apps/web/src/components/sign-in-screen.tsx`
- Create: `apps/web/src/components/organization-onboarding.tsx`
- Create: `apps/web/src/components/oauth-consent-screen.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/sign-in/page.tsx`
- Create: `apps/web/src/app/consent/page.tsx`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/components/inventory-app.test.tsx`
- Create: `apps/web/src/components/auth-gate.test.tsx`

1. Write UI tests for loading, signed-out, no-organization, authenticated, sign-out, and OAuth consent states.
2. Add a Better Auth client with organization and OAuth-provider client plugins.
3. Render a Google sign-in gate before any cached household data can appear.
4. Add first-organization onboarding and active-organization selection.
5. Pass the authenticated household and member identifiers into the inventory application and offline hooks.
6. Add OAuth consent accept/deny handling for MCP clients.
7. Run component tests, all web tests, lint, and static build.

## Task 7: Add organization, member, role, invitation, and group management

**Files:**
- Create: `apps/web/src/components/organization-settings.tsx`
- Create: `apps/web/src/components/member-management.tsx`
- Create: `apps/web/src/components/group-management.tsx`
- Create: `apps/web/src/components/invitation-management.tsx`
- Create: `apps/web/src/components/organization-settings.test.tsx`
- Modify: `apps/web/src/components/inventory-app.tsx`
- Modify: `apps/web/src/app/globals.css`

1. Write permission-focused UI tests for owner, admin, and member roles.
2. Add organization switching and organization settings navigation.
3. Add member listing, owner/admin role changes, and member removal using Better Auth organization endpoints.
4. Add teams labeled as Groups, including group creation and membership management.
5. Add invitation creation, listing, cancellation, acceptance links, and copyable invitation URLs; do not claim that email is sent without an email provider.
6. Ensure member-only users can view household membership but cannot access administration controls.
7. Run organization UI tests and the complete web suite.

## Task 8: Document configuration, security, and deployment

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deployment.md`
- Modify: `docs/requirements.md`
- Modify: `docs/product-architecture.md`

1. Document the Google Cloud OAuth client setup and exact local/production callback URLs.
2. Document required Worker secrets: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`.
3. Document organization isolation, default roles, groups, invitation behavior, offline cache boundaries, session revocation, and audit attribution.
4. Document ChatGPT MCP setup, OAuth discovery, dynamic client registration, scopes, and the organization-consent model.
5. Document the migration and legacy-household claiming behavior.
6. Run documentation link/path checks and `git diff --check`.

## Task 9: Complete verification and production handoff

**Files:**
- Review: all changed files

1. Run `npm test`.
2. Run `npm run lint`.
3. Run `npm run build`.
4. Run `npm run smoke` against the local Worker.
5. Run `git diff --check`, inspect the diff for secrets, and perform a focused authentication/authorization review.
6. Commit each cohesive implementation milestone on `feat/google-auth-organizations`.
7. After receiving the Google client ID and secret, store all three production credentials through `wrangler secret put`, apply the D1 migration, deploy the Worker, and verify Google sign-in plus ChatGPT MCP OAuth end to end.
