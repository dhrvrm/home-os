export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOMEOS_DEFAULT_HOUSEHOLD_ID: string;
  HOMEOS_MCP_TOKEN?: string;
  HOMEOS_SETUP_TOKEN?: string;
  HOMEOS_PASSWORD_PEPPER?: string;
}
