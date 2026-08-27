export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HOMEOS_DEFAULT_HOUSEHOLD_ID: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  HOMEOS_TEST_AUTH?: string;
}
