import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;

export interface AuthenticatedHome {
  cookie: string;
  userId: string;
  organizationId: string;
  householdId: string;
  membershipId: string;
  sessionId: string;
  role: string;
}

export async function createAuthenticatedHome(prefix: string): Promise<AuthenticatedHome> {
  const suffix = crypto.randomUUID();
  const jar = new Map<string, string>();
  const signedUp = await authRequest("/api/auth/sign-up/email", {
    name: `${prefix} owner`,
    email: `${prefix}-${suffix}@example.com`,
    password: "correct-horse-battery-staple",
  });
  expect(signedUp.status).toBe(200);
  captureCookies(signedUp, jar);

  const created = await authRequest(
    "/api/auth/organization/create",
    { name: `${prefix} home`, slug: `${prefix}-${suffix}` },
    jar,
  );
  expect(created.status).toBe(200);
  captureCookies(created, jar);
  const organization = await created.json<{ id: string }>();

  const activated = await authRequest(
    "/api/auth/organization/set-active",
    { organizationId: organization.id },
    jar,
  );
  expect(activated.status).toBe(200);
  captureCookies(activated, jar);

  const cookie = cookieValue(jar);
  const response = await apiWithAuth("/api/v1/session", cookie);
  expect(response.status).toBe(200);
  const envelope = await response.json<{
    data: {
      authenticated: true;
      user: { id: string };
      activeOrganization: { id: string };
      membership: { id: string; role: string };
      household: { id: string };
    };
  }>();
  const session = await testEnv.DB.prepare(
    "SELECT id FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1",
  )
    .bind(envelope.data.user.id)
    .first<{ id: string }>();
  expect(session).not.toBeNull();
  return {
    cookie,
    userId: envelope.data.user.id,
    organizationId: envelope.data.activeOrganization.id,
    householdId: envelope.data.household.id,
    membershipId: envelope.data.membership.id,
    sessionId: session!.id,
    role: envelope.data.membership.role,
  };
}

export function apiWithAuth(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  headers.set("Origin", "https://home-os.test");
  return exports.default.fetch(
    new Request(`https://home-os.test${path}`, { ...init, headers }),
  );
}

async function authRequest(path: string, body: unknown, jar?: Map<string, string>): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://home-os.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://home-os.test",
        ...(jar?.size ? { Cookie: cookieValue(jar) } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function captureCookies(response: Response, jar: Map<string, string>): void {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieValue(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
