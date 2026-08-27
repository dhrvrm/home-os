import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [organizationClient({ teams: { enabled: true } }), oauthProviderClient()],
});

export interface HomeSessionContext {
  authenticated: boolean;
  user?: { id: string; name: string; email: string; image?: string | null };
  organizations?: Array<{ id: string; name: string; slug: string; logo?: string | null }>;
  activeOrganization?: { id: string; name: string; slug: string; logo?: string | null } | null;
  membership?: { id: string; role: string } | null;
  household?: { id: string; name: string; organizationId: string } | null;
}

export interface FullOrganization {
  id: string;
  name: string;
  slug: string;
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user: { id: string; name: string; email: string; image?: string | null };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
  }>;
  teams: Array<{ id: string; name: string; memberCount?: number }>;
}

export async function loadHomeSession(): Promise<HomeSessionContext> {
  const response = await authRequest<{ data: HomeSessionContext; error: null }>("/api/v1/session");
  return response.data;
}

export async function loadFullOrganization(organizationId: string): Promise<FullOrganization> {
  return authRequest<FullOrganization>(
    `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(organizationId)}`,
  );
}

export async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null) as T | { message?: string; error?: { message?: string } } | null;
  if (!response.ok) {
    const problem = body && typeof body === "object"
      ? "message" in body && body.message
        ? body.message
        : "error" in body && body.error?.message
          ? body.error.message
          : null
      : null;
    throw new Error(problem ?? "Home OS could not complete the account request.");
  }
  return body as T;
}

export async function postAuth<T>(path: string, body: unknown): Promise<T> {
  return authRequest<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function organizationSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${slug || "home"}-${crypto.randomUUID().slice(0, 8)}`;
}
