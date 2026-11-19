import OAuthProvider, { getOAuthApi, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";

it("characterizes pinned provider: consent cookies, PKCE, issuer, form parser and indefinite refresh/client options", async () => {
  const options: OAuthProviderOptions = {
    apiRoute: "/mcp", apiHandler: { fetch: () => new Response("admitted") }, defaultHandler: { fetch: () => new Response("app") },
    authorizeEndpoint: "/api/oauth/authorize", tokenEndpoint: "/api/oauth/token", clientRegistrationEndpoint: "/api/oauth/register",
    resourceMetadata: { resource: "https://home-os.test/mcp", authorization_servers: ["https://home-os.test"] },
    accessTokenTTL: 900, refreshTokenTTL: undefined, clientRegistrationTTL: undefined, scopesSupported: ["home:access"], onError: () => {},
  };
  const provider = new OAuthProvider(options);
  const helpers = getOAuthApi(options, env);
  const client = await helpers.createClient({ clientName: "Provider fixture", redirectUris: ["https://client.example/callback"], tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"] });
  const verifier = "V".repeat(64);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const parsed = await helpers.parseAuthRequest(new Request(`https://home-os.test/api/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUris[0]!, scope: "home:access", code_challenge: challenge, code_challenge_method: "S256", resource: "https://home-os.test/mcp", state: "state" })}`));
  const description = await helpers.describeConsent(parsed);
  expect(description).toMatchObject({ clientName: "Provider fixture", redirectHost: "client.example" });
  const consent = await helpers.beginConsent(parsed);
  expect(consent.headers.get("x-frame-options")).toBe("DENY");
  const approved = await helpers.approveConsent(new Request("https://home-os.test/api/v1/auth/consent/approve", { method: "POST", headers: { cookie: consent.headers.get("set-cookie")!.split(";")[0]! } }), consent.handle);
  const completed = await helpers.completeAuthorization({ request: approved.request, userId: "fixture", props: { fixture: true }, scope: ["home:access"], metadata: {}, revokeExistingGrants: false });
  const redirect = new URL(completed.redirectTo);
  expect(redirect.searchParams.get("iss")).toBe("https://home-os.test");
  const ctx = createExecutionContext();
  const exchange = await provider.fetch(new Request("https://home-os.test/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: client.redirectUris[0]!, resource: "https://home-os.test/mcp" }) }), env, ctx);
  const tokens = await exchange.json() as { access_token: string; refresh_token: string; expires_in: number };
  expect(exchange.status).toBe(200); expect(tokens.expires_in).toBe(900); expect(tokens.refresh_token).toBeTruthy();
  const grants = await helpers.listUserGrants("fixture"); expect(grants.items).toHaveLength(1); expect(grants.items[0]!.expiresAt).toBeUndefined();
  const json = await provider.fetch(new Request("https://home-os.test/api/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }) }), env, ctx);
  expect(json.status).toBe(400); expect(await json.json()).toMatchObject({ error: "invalid_request" });
  await waitOnExecutionContext(ctx);
});
