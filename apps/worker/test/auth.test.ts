import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth/auth";
import { resolveRequestAuth } from "../src/auth/context";
import type { Env } from "../src/env";

const testEnv = env as unknown as Env;

describe("Home OS authentication", () => {
  it("returns no context without a valid session", async () => {
    const context = await resolveRequestAuth(new Request("https://home-os.test/api/v1/session"), testEnv);
    expect(context).toBeNull();
  });

  it("creates isolated organizations and maps the first one to legacy inventory", async () => {
    const first = await createUserAndOrganization("first");
    const second = await createUserAndOrganization("second");

    expect(first.context.user.email).toContain("first-");
    expect(first.context.organization).toMatchObject({ name: "First home" });
    expect(first.context.role).toBe("owner");
    expect(first.context.household?.id).toBe("home");

    expect(second.context.organization).toMatchObject({ name: "Second home" });
    expect(second.context.role).toBe("owner");
    expect(second.context.household?.id).toBe(second.organizationId);
    expect(second.context.household?.id).not.toBe(first.context.household?.id);
    expect(second.context.organizations).toHaveLength(1);
  });

  it("keeps password sign-up disabled outside the test environment", async () => {
    const productionAuth = createAuth({ ...testEnv, HOMEOS_TEST_AUTH: undefined });
    const response = await productionAuth.handler(
      jsonRequest("/api/auth/sign-up/email", {
        name: "No password",
        email: `disabled-${crypto.randomUUID()}@example.com`,
        password: "correct-horse-battery-staple",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("supports invitations, role changes, groups, and immediate member removal", async () => {
    const owner = await createUserAndOrganization("organization-owner");
    const roommate = await createUser("organization-roommate");
    const auth = createAuth(testEnv);

    const invited = await auth.handler(
      jsonRequest(
        "/api/auth/organization/invite-member",
        { email: roommate.email, role: "member", organizationId: owner.organizationId },
        owner.jar,
      ),
    );
    expect(invited.status).toBe(200);
    const invitation = await invited.json<{ id: string }>();

    const accepted = await auth.handler(
      jsonRequest(
        "/api/auth/organization/accept-invitation",
        { invitationId: invitation.id },
        roommate.jar,
      ),
    );
    expect(accepted.status).toBe(200);

    const fullResponse = await auth.handler(
      authGet(`/api/auth/organization/get-full-organization?organizationId=${owner.organizationId}`, owner.jar),
    );
    expect(fullResponse.status).toBe(200);
    const full = await fullResponse.json<{ members: Array<{ id: string; userId: string; role: string }> }>();
    const roommateMember = full.members.find(({ userId }) => userId === roommate.userId);
    expect(roommateMember).toMatchObject({ role: "member" });

    const updated = await auth.handler(
      jsonRequest(
        "/api/auth/organization/update-member-role",
        { memberId: roommateMember!.id, role: "admin", organizationId: owner.organizationId },
        owner.jar,
      ),
    );
    expect(updated.status).toBe(200);

    const teamResponse = await auth.handler(
      jsonRequest(
        "/api/auth/organization/create-team",
        { name: "Kitchen", organizationId: owner.organizationId },
        owner.jar,
      ),
    );
    expect(teamResponse.status).toBe(200);
    const team = await teamResponse.json<{ id: string }>();

    const addedToTeam = await auth.handler(
      jsonRequest(
        "/api/auth/organization/add-team-member",
        { teamId: team.id, userId: roommate.userId, organizationId: owner.organizationId },
        owner.jar,
      ),
    );
    expect(addedToTeam.status).toBe(200);

    const teamMembersResponse = await auth.handler(
      authGet(`/api/auth/organization/list-team-members?teamId=${team.id}`, owner.jar),
    );
    expect(teamMembersResponse.status, await teamMembersResponse.clone().text()).toBe(200);
    await expect(teamMembersResponse.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: roommate.userId, teamId: team.id })]),
    );

    const removed = await auth.handler(
      jsonRequest(
        "/api/auth/organization/remove-member",
        { memberIdOrEmail: roommateMember!.id, organizationId: owner.organizationId },
        owner.jar,
      ),
    );
    expect(removed.status).toBe(200);

    const roommateContext = await resolveRequestAuth(
      new Request("https://home-os.test/api/v1/session", { headers: cookieHeaders(roommate.jar) }),
      testEnv,
    );
    expect(roommateContext?.organizations).toEqual([]);
    expect(roommateContext?.household).toBeNull();
  });
});

async function createUserAndOrganization(prefix: string) {
  const auth = createAuth(testEnv);
  const user = await createUser(prefix);
  const { jar } = user;
  const suffix = crypto.randomUUID();

  const created = await auth.handler(
    jsonRequest(
      "/api/auth/organization/create",
      { name: `${capitalize(prefix)} home`, slug: `${prefix}-${suffix}` },
      jar,
    ),
  );
  if (created.status !== 200) {
    throw new Error(`organization creation failed (${created.status}): ${await created.clone().text()}; cookies=${JSON.stringify([...jar])}`);
  }
  captureCookies(created, jar);
  const organization = await created.json<{ id: string }>();

  const activated = await auth.handler(
    jsonRequest("/api/auth/organization/set-active", { organizationId: organization.id }, jar),
  );
  expect(activated.status).toBe(200);
  captureCookies(activated, jar);

  const context = await resolveRequestAuth(
    new Request("https://home-os.test/api/v1/session", { headers: cookieHeaders(jar) }),
    testEnv,
  );
  expect(context).not.toBeNull();
  return { context: context!, organizationId: organization.id, jar };
}

async function createUser(prefix: string) {
  const auth = createAuth(testEnv);
  const suffix = crypto.randomUUID();
  const email = `${prefix}-${suffix}@example.com`;
  const jar = new Map<string, string>();
  const signedUp = await auth.handler(
    jsonRequest("/api/auth/sign-up/email", {
      name: `${prefix} user`,
      email,
      password: "correct-horse-battery-staple",
    }),
  );
  expect(signedUp.status).toBe(200);
  captureCookies(signedUp, jar);
  const body = await signedUp.json<{ user: { id: string } }>();
  await testEnv.DB.prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE id = ?`)
    .bind(body.user.id)
    .run();
  return { jar, email, userId: body.user.id };
}

function authGet(path: string, jar: Map<string, string>): Request {
  return new Request(`https://home-os.test${path}`, {
    headers: { Origin: "https://home-os.test", ...cookieHeaders(jar) },
  });
}

function jsonRequest(path: string, body: unknown, jar?: Map<string, string>): Request {
  return new Request(`https://home-os.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://home-os.test",
      ...cookieHeaders(jar),
    },
    body: JSON.stringify(body),
  });
}

function cookieHeaders(jar?: Map<string, string>): Record<string, string> {
  if (!jar?.size) return {};
  return { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; ") };
}

function captureCookies(response: Response, jar: Map<string, string>): void {
  const values = response.headers.getSetCookie?.() ?? [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
