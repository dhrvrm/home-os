export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOMEOS_DEFAULT_HOUSEHOLD_ID: string;
  HOMEOS_MCP_TOKEN?: string;
  HOMEOS_SETUP_TOKEN?: string;
  HOMEOS_PASSWORD_PEPPER?: string;
  HOMEOS_VAPID_PUBLIC_KEY?: string;
  HOMEOS_VAPID_PRIVATE_KEY?: string;
  HOMEOS_VAPID_SUBJECT?: string;
}
