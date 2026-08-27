# Authentication and MCP connection

Home OS uses Google for user identity and Better Auth in the existing Cloudflare Worker for sessions, organizations, invitations, roles, groups, and MCP OAuth. No separate authentication server is required.

## Google OAuth application

Create an OAuth 2.0 Client ID of type **Web application** in Google Cloud Console. Configure the consent screen for the accounts that may use Home OS, then add these values exactly:

| Environment | Authorized JavaScript origin | Authorized redirect URI |
|---|---|---|
| Local | `http://localhost:8787` | `http://localhost:8787/api/auth/callback/google` |
| Production | `https://home-os.dhruvverma028.workers.dev` | `https://home-os.dhruvverma028.workers.dev/api/auth/callback/google` |

Google may take a few minutes to propagate changes. Do not place the client secret in `.env.example`, `wrangler.jsonc`, a client-side `NEXT_PUBLIC_*` variable, GitHub, or chat logs.

For local development, copy the ignored vars file and replace its placeholders:

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

For production, set all three values as encrypted Worker secrets:

```bash
source scripts/cloudflare-env.zsh
openssl rand -base64 48 | npx wrangler secret put BETTER_AUTH_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

`BETTER_AUTH_SECRET` must remain stable. Rotating it signs users out and can invalidate tokens. `BETTER_AUTH_URL` is a non-secret production variable in `wrangler.jsonc` and must exactly match the public Worker origin.

## User and organization flow

1. A signed-out visitor sees only **Continue with Google**.
2. After Google returns, the user selects an existing home or creates one.
3. The first organization safely claims the legacy `home` household; later organizations receive isolated household records.
4. Owners and admins can create 48-hour invitations, change roles, remove members, and organize members into groups.
5. Invitation email delivery is not configured yet. Copy the generated invitation link and send it to the invited Google email. The verified Google email must match.

Roles are intentionally small: `owner`, `admin`, and `member`. Owners/admins manage access; members use household modules. Groups are organizational labels for rooms or responsibilities and do not grant additional permissions in this iteration.

## Connect ChatGPT to Home OS MCP

The production MCP URL is:

```text
https://home-os.dhruvverma028.workers.dev/mcp
```

Home OS publishes OAuth protected-resource and authorization-server metadata, supports dynamic client registration, PKCE, refresh tokens, and read scopes `inventory:read` and `activity:read`. A connection is bound to the active organization chosen on the Home OS consent screen.

In ChatGPT, enable Developer mode under **Settings → Security and login**, open ChatGPT Plugins, choose the plus button, and add the public URL above as the connection. ChatGPT discovers OAuth automatically, opens Google/Home OS authorization, and returns after consent. Developer mode availability can depend on account or workspace policy.

Before connecting ChatGPT, verify the server directly:

```bash
curl -i https://home-os.dhruvverma028.workers.dev/mcp
curl -fsS https://home-os.dhruvverma028.workers.dev/.well-known/oauth-protected-resource/mcp
npx @modelcontextprotocol/inspector@latest
```

The first call should return an OAuth challenge, not household data. After authorization, tokens are checked for issuer, audience, expiry, required scopes, an active Home OS session, organization claim, and current membership on every request. Removing the member or session therefore revokes MCP data access without rotating a shared secret.

The ChatGPT connection procedure follows OpenAI's current [connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [OAuth authentication](https://developers.openai.com/plugins/build/auth) guidance.
