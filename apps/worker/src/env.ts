import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOMEOS_DEFAULT_HOUSEHOLD_ID: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  OAUTH_MAINTENANCE_PROVIDER?: OAuthHelpers;
  HOMEOS_MCP_RESOURCE: string;
  HOMEOS_SETUP_TOKEN?: string;
  HOMEOS_PASSWORD_PEPPER?: string;
  HOMEOS_VAPID_PUBLIC_KEY?: string;
  HOMEOS_VAPID_PRIVATE_KEY?: string;
  HOMEOS_VAPID_SUBJECT?: string;
}
