export const HOME_OS_AUTH_BASE_PATH = "/api/auth";
export const HOME_OS_MCP_PATH = "/mcp";
export const HOME_OS_ORGANIZATION_CLAIM = "https://home-os.app/organization_id";

export const HOME_OS_MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "inventory:read",
  "activity:read",
] as const;

export function requiresOrganization(scopes: readonly string[]): boolean {
  return scopes.includes("inventory:read") || scopes.includes("activity:read");
}
