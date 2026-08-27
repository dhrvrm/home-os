import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import type { Env } from "../env";
import {
  HOME_OS_AUTH_BASE_PATH,
  HOME_OS_MCP_PATH,
  HOME_OS_MCP_SCOPES,
  HOME_OS_ORGANIZATION_CLAIM,
  requiresOrganization,
} from "./constants";

export function createAuth(env: Env) {
  const baseURL = normalizedBaseURL(env.BETTER_AUTH_URL);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    appName: "Home OS",
    baseURL,
    basePath: HOME_OS_AUTH_BASE_PATH,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL, "http://localhost:8787", "http://127.0.0.1:8787"],
    emailAndPassword: { enabled: env.HOMEOS_TEST_AUTH === "true" },
    socialProviders: googleConfigured
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            prompt: "select_account",
          },
        }
      : {},
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: baseURL.startsWith("https://"),
      },
    },
    plugins: [
      organization({
        creatorRole: "owner",
        membershipLimit: 100,
        invitationExpiresIn: 60 * 60 * 48,
        requireEmailVerificationOnInvitation: true,
        organizationHooks: {
          afterCreateTeam: async ({ team, user }) => {
            if (!user) return;
            const membershipKey = await teamMembershipKey(team.id, user.id);
            await env.DB.batch([
              env.DB.prepare(
                `INSERT OR IGNORE INTO teamMember
                   (id, teamId, userId, membershipKey, createdAt)
                 VALUES (?, ?, ?, ?, ?)`,
              ).bind(crypto.randomUUID(), team.id, user.id, membershipKey, Date.now()),
              env.DB.prepare(
                `UPDATE team SET memberCount = memberCount + 1, updatedAt = ? WHERE id = ?`,
              ).bind(Date.now(), team.id),
            ]);
          },
        },
        teams: {
          enabled: true,
          defaultTeam: { enabled: true },
          maximumTeams: 50,
          maximumMembersPerTeam: 100,
        },
      }),
      jwt({
        jwt: {
          issuer: `${baseURL}${HOME_OS_AUTH_BASE_PATH}`,
          audience: `${baseURL}${HOME_OS_MCP_PATH}`,
        },
      }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: `${baseURL}${HOME_OS_MCP_PATH}`,
        scopes: [...HOME_OS_MCP_SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        postLogin: {
          page: "/consent",
          shouldRedirect: async ({ session, scopes }) =>
            requiresOrganization(scopes) && !session.activeOrganizationId,
          consentReferenceId: async ({ session, scopes }) => {
            if (!requiresOrganization(scopes)) return undefined;
            return typeof session.activeOrganizationId === "string"
              ? session.activeOrganizationId
              : undefined;
          },
        },
        customAccessTokenClaims: async ({ referenceId }) =>
          referenceId ? { [HOME_OS_ORGANIZATION_CLAIM]: referenceId } : {},
      }),
    ],
  });
}

function normalizedBaseURL(value: string): string {
  return value.replace(/\/+$/, "");
}

async function teamMembershipKey(teamId: string, userId: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([teamId, userId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type HomeOSAuth = ReturnType<typeof createAuth>;
