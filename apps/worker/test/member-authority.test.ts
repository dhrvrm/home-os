import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { digest } from "../src/auth/crypto";

const origin = "https://home-os.test";
const password = "owner authority fixture password";

function request(
  path: string,
  cookie: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  return new Request(`${origin}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-HomeOS-Member": "local-owner",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function ownerCookie() {
  const response = await exports.default.fetch(
    request("/auth/setup", "", {
      name: "Owner",
      email: "owner@example.test",
      password,
      setupToken: "test-setup-secret",
      remember: true,
    }),
  );
  expect(response.status).toBe(201);
  return response.headers
    .getSetCookie()
    .findLast((value) => /^homeos_session=[a-f0-9]{64};/.test(value))!
    .split(";")[0]!;
}
async function seedOtherOwner() {
  const response = await env.DB.prepare(
    "INSERT INTO members (id, household_id, display_name, email, role, created_at, updated_at) VALUES ('other-owner', 'home', 'Other owner', 'other@example.test', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  ).run();
  expect(response.meta.changes).toBe(1);
}
function heldJSON(path: string, cookie: string, method: string, body: unknown) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        enter();
        await released;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const headers = request(path, cookie).headers;
  const response = worker.fetch(
    new Request(`${origin}/api/v1${path}`, { method, headers, body: stream }),
    env,
  );
  return { entered, release, response };
}
async function memberAuditCount() {
  return env.DB.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE entity_type = 'member'",
  ).first<number>("count");
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_bootstrap"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM mutation_guards"),
    env.DB.prepare(
      "UPDATE members SET role = 'owner', archived_at = NULL, email = NULL, display_name = 'Home owner' WHERE id = 'local-owner'",
    ),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
});

describe("continuing owner authority at transaction commit", () => {
  it("cannot reactivate a deactivated owner through an already admitted streamed edit", async () => {
    const cookie = await ownerCookie();
    await seedOtherOwner();
    const audit = await memberAuditCount();
    const held = heldJSON("/members/local-owner", cookie, "PATCH", {
      active: true,
    });
    await held.entered;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE members SET archived_at = ? WHERE id = 'local-owner'",
      ).bind(new Date().toISOString()),
      env.DB.prepare(
        "DELETE FROM auth_sessions WHERE member_id = 'local-owner'",
      ),
    ]);
    held.release();
    const response = await held.response;
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT archived_at FROM members WHERE id = 'local-owner'",
      ).first<string>("archived_at"),
    ).not.toBeNull();
    expect(await memberAuditCount()).toBe(audit);
    const login = await exports.default.fetch(
      request("/auth/login", "", {
        email: "owner@example.test",
        password,
        remember: false,
      }),
    );
    expect(login.status).toBe(401);
  });

  it("cannot create an owner after the initiating owner is demoted", async () => {
    const cookie = await ownerCookie();
    await seedOtherOwner();
    const audit = await memberAuditCount();
    const held = heldJSON("/members", cookie, "POST", {
      name: "Unauthorized owner",
      email: "forbidden@example.test",
      password,
      role: "owner",
    });
    await held.entered;
    await env.DB.prepare(
      "UPDATE members SET role = 'member' WHERE id = 'local-owner'",
    ).run();
    held.release();
    expect((await held.response).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT id FROM members WHERE email = 'forbidden@example.test'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT member_id FROM auth_accounts WHERE email = 'forbidden@example.test'",
      ).first(),
    ).toBeNull();
    expect(await memberAuditCount()).toBe(audit);
  });

  it("cannot reset another password after the exact initiating session ends", async () => {
    const cookie = await ownerCookie();
    await seedOtherOwner();
    await env.DB.prepare(
      "INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES ('other-owner', 'other@example.test', 'unchanged-verifier', CURRENT_TIMESTAMP)",
    ).run();
    const before = await env.DB.prepare(
      "SELECT password_hash, credential_version FROM auth_accounts WHERE member_id = 'other-owner'",
    ).first();
    const audit = await memberAuditCount();
    const held = heldJSON("/members/other-owner/password", cookie, "POST", {
      password: "replacement owner fixture password",
    });
    await held.entered;
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await digest(cookie.split("=")[1]!))
      .run();
    held.release();
    expect((await held.response).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT password_hash, credential_version FROM auth_accounts WHERE member_id = 'other-owner'",
      ).first(),
    ).toEqual(before);
    expect(await memberAuditCount()).toBe(audit);
  });

  it("rechecks authority inside the mutation batch rather than before dispatch", async () => {
    const cookie = await ownerCookie();
    await seedOtherOwner();
    const audit = await memberAuditCount();
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare(
              "UPDATE members SET role = 'member' WHERE id = 'local-owner'",
            ).run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      request(
        "/members/other-owner",
        cookie,
        { name: "Unauthorized rename" },
        "PATCH",
      ),
      { ...env, DB: database },
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT display_name FROM members WHERE id = 'other-owner'",
      ).first<string>("display_name"),
    ).toBe("Other owner");
    expect(await memberAuditCount()).toBe(audit);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM mutation_guards",
      ).first<number>("count"),
    ).toBe(0);
  });

  it.each(["expired", "replaced"])(
    "refuses an %s grant even when its session row remains",
    async (reason) => {
      const cookie = await ownerCookie();
      await seedOtherOwner();
      const audit = await memberAuditCount();
      const held = heldJSON("/members/other-owner", cookie, "PATCH", {
        name: "Unauthorized rename",
      });
      await held.entered;
      if (reason === "expired") {
        await env.DB.prepare(
          "UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE member_id = 'local-owner'",
        ).run();
      } else {
        await env.DB.prepare(
          "UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'local-owner'",
        ).run();
      }
      held.release();
      expect((await held.response).status).toBe(403);
      expect(
        await env.DB.prepare(
          "SELECT display_name FROM members WHERE id = 'other-owner'",
        ).first<string>("display_name"),
      ).toBe("Other owner");
      expect(await memberAuditCount()).toBe(audit);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM mutation_guards",
        ).first<number>("count"),
      ).toBe(0);
    },
  );

  it("allows a currently admitted owner to demote themselves and removes its temporary guard", async () => {
    const cookie = await ownerCookie();
    await seedOtherOwner();
    const response = await exports.default.fetch(
      request("/members/local-owner", cookie, { role: "member" }, "PATCH"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { member: { id: "local-owner", role: "member", active: true } },
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM mutation_guards",
      ).first<number>("count"),
    ).toBe(0);
  });
});
