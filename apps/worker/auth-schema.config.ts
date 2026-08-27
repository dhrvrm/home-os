import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";

// This file is only used by the Better Auth CLI to generate a deterministic
// SQLite schema. Runtime configuration lives in src/auth/auth.ts.
export const auth = betterAuth({
  database: new DatabaseSync(":memory:"),
  baseURL: "http://localhost:8787",
  secret: "home-os-schema-generation-secret-32-chars",
  emailAndPassword: { enabled: true },
  plugins: [
    organization({ teams: { enabled: true } }),
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: "http://localhost:8787/mcp",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ],
});
