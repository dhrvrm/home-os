import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
const origin = "https://home-os.test";
let cookie: string;
function request(
  path: string,
  body: unknown,
  operationId = "authority-operation",
) {
  return new Request(`${origin}/api/v1${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
      "X-HomeOS-Member": "local-owner",
      "X-Operation-ID": operationId,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_accounts"),
    env.DB.prepare("DELETE FROM auth_bootstrap"),
    env.DB.prepare("DELETE FROM auth_attempts"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM processed_operations"),
    env.DB.prepare("DELETE FROM household_command_receipts"),
    env.DB.prepare("DELETE FROM meals"),
    env.DB.prepare("DELETE FROM recipes"),
    env.DB.prepare("DELETE FROM contacts"),
    env.DB.prepare("DELETE FROM expense_rules"),
    env.DB.prepare("DELETE FROM notification_preferences"),
    env.DB.prepare("DELETE FROM inventory_items"),
    env.DB.prepare(
      "UPDATE members SET role = 'owner', archived_at = NULL WHERE id = 'local-owner'",
    ),
    env.DB.prepare("DELETE FROM members WHERE id <> 'local-owner'"),
  ]);
  const response = await exports.default.fetch(
    request("/auth/setup", {
      name: "Owner",
      email: "owner@example.test",
      password: "continuing authority fixture password",
      setupToken: "test-setup-secret",
      remember: true,
    }),
  );
  expect(response.status).toBe(201);
  cookie = response.headers
    .getSetCookie()
    .findLast((value) => /^homeos_session=[a-f0-9]{64};/.test(value))!
    .split(";")[0]!;
});
describe("continuing browser authority", () => {
  it("rolls back inventory, receipt and audit if the exact grant ends at acceptance", async () => {
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare("DELETE FROM auth_sessions").run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      request("/items", { id: "rejected-item", name: "Rejected rice" }),
      { ...env, DB: database },
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT id FROM inventory_items WHERE id = 'rejected-item'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM processed_operations",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM household_command_receipts",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM audit_events WHERE operation_id = 'authority-operation'",
      ).first(),
    ).toBeNull();
  });
  it("conflicts when an operation ID is reused with changed stable intent", async () => {
    expect(
      (await exports.default.fetch(request("/items", { name: "Rice" }))).status,
    ).toBe(201);
    expect(
      (await exports.default.fetch(request("/items", { name: "Changed rice" })))
        .status,
    ).toBe(409);
  });
});

const mutations = [
  ["inventory", "/items", { name: "Rice" }, "inventory_items", "POST"],
  [
    "expense",
    "/expenses",
    {
      name: "Rent",
      amountMinor: 1200,
      cadence: { unit: "month", interval: 1, anchorDate: "2026-01-01" },
      participants: [{ memberId: "local-owner" }],
    },
    "expense_rules",
    "POST",
  ],
  [
    "recipe",
    "/recipes",
    {
      name: "Dal",
      servings: 2,
      ingredients: [{ name: "Dal" }],
      instructions: "Cook",
    },
    "recipes",
    "POST",
  ],
  [
    "meal",
    "/meals",
    {
      title: "Dinner",
      recipeIds: [],
      cookingAt: "2090-01-02T13:00:00Z",
      timezone: "Asia/Kolkata",
      reminderMinutesBefore: 30,
    },
    "meals",
    "POST",
  ],
  [
    "contact",
    "/contacts",
    { name: "Plumber", role: "Repairs" },
    "contacts",
    "POST",
  ],
  ["member", "/members/other-owner", { name: "Renamed" }, "members", "PATCH"],
  [
    "preferences",
    "/notifications/preferences",
    { mealReminders: false, pushEnabled: false },
    "notification_preferences",
    "PUT",
  ],
] as const;
for (const [domain, path, body, table, method] of mutations) {
  for (const reason of [
    "revoked",
    "replaced",
    "deactivated",
    ...(domain === "preferences" ? [] : ["demoted"]),
  ] as const) {
    it(`${domain} accepts nothing when authority is ${reason} immediately before its batch`, async () => {
      await env.DB.prepare(
        "INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES ('other-owner', 'home', 'Other owner', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      ).run();
      let payload: unknown = body;
      if (domain === "meal") {
        const recipeResponse = await exports.default.fetch(
          request(
            "/recipes",
            {
              name: "Dal",
              servings: 2,
              ingredients: [{ name: "Dal" }],
              instructions: "Cook",
            },
            "seed-recipe",
          ),
        );
        expect(recipeResponse.status).toBe(201);
        const recipe = await recipeResponse.json<{
          data: { recipe: { id: string } };
        }>();
        payload = { ...body, recipeIds: [recipe.data.recipe.id] };
      }
      const count = () =>
        env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n");
      const before = await count();
      const auditBefore = await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_events",
      ).first<number>("n");
      const receiptBefore = await env.DB.prepare(
        "SELECT count(*) AS n FROM household_command_receipts",
      ).first<number>("n");
      let intercepted = false;
      const guards = new WeakSet<D1PreparedStatement>();
      const database = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const original = target.prepare(sql);
              if (!sql.includes("INSERT INTO mutation_guards")) return original;
              return new Proxy(original, {
                get(statement, property) {
                  if (property === "bind")
                    return (...values: unknown[]) => {
                      const bound = statement.bind(...values);
                      guards.add(bound);
                      return bound;
                    };
                  const value = Reflect.get(statement, property, statement);
                  return typeof value === "function"
                    ? value.bind(statement)
                    : value;
                },
              });
            };
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (
                !intercepted &&
                statements.some((statement) => guards.has(statement))
              ) {
                intercepted = true;
                await env.DB.prepare(
                  reason === "revoked"
                    ? "DELETE FROM auth_sessions WHERE member_id = 'local-owner'"
                    : reason === "replaced"
                      ? "UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'local-owner'"
                      : reason === "deactivated"
                        ? "UPDATE members SET archived_at = CURRENT_TIMESTAMP WHERE id = 'local-owner'"
                        : "UPDATE members SET role = 'viewer' WHERE id = 'local-owner'",
                ).run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const raw = request(path, payload);
      const response = await worker.fetch(new Request(raw, { method }), {
        ...env,
        DB: database,
      });
      expect(intercepted).toBe(true);
      expect(response.status).toBe(403);
      expect(await count()).toBe(before);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_events",
        ).first<number>("n"),
      ).toBe(auditBefore);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM household_command_receipts",
        ).first<number>("n"),
      ).toBe(receiptBefore);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM mutation_guards",
        ).first<number>("n"),
      ).toBe(0);
      if (domain === "member")
        expect(
          await env.DB.prepare(
            "SELECT display_name FROM members WHERE id = 'other-owner'",
          ).first<string>("display_name"),
        ).toBe("Other owner");
    });
  }
}

it("binds inventory receipts to stable intent and actor, independent of generated IDs and device metadata", async () => {
  const first = await exports.default.fetch(
    request("/items", { name: "Rice" }),
  );
  const accepted = await first.json<{ data: { item: { id: string } } }>();
  const sameRequest = request("/items", { name: "Rice" });
  sameRequest.headers.set("X-Device-ID", "another-device");
  sameRequest.headers.set("X-Client-Time", "2026-01-01T00:00:00Z");
  const same = await exports.default.fetch(sameRequest);
  expect(same.status).toBe(201);
  expect(await same.json()).toMatchObject({
    data: { item: { id: accepted.data.item.id } },
  });
  const { digest } = await import("../src/auth/crypto");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES ('second-actor', 'home', 'Second', 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "INSERT INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES ('second-actor', 'second@example.test', 'fixture-verifier', CURRENT_TIMESTAMP)",
    ),
    env.DB.prepare(
      "INSERT INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, 'second-actor', 1, '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)",
    ).bind(await digest("b".repeat(64))),
  ]);
  const other = request("/items", { name: "Rice" });
  other.headers.set("Cookie", `homeos_session=${"b".repeat(64)}`);
  other.headers.set("X-HomeOS-Member", "second-actor");
  expect((await exports.default.fetch(other)).status).toBe(409);
});

it("refuses legacy processed receipts that cannot prove the same caller intent", async () => {
  await env.DB.prepare(
    "INSERT INTO processed_operations (household_id, operation_id, entity_type, entity_id, result_json, processed_at) VALUES ('home', 'authority-operation', 'inventory_item', 'legacy', '{}', CURRENT_TIMESTAMP)",
  ).run();
  expect(
    (await exports.default.fetch(request("/items", { name: "Rice" }))).status,
  ).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM inventory_items",
    ).first<number>("n"),
  ).toBe(0);
});

it("cannot disclose a receipt through the batch-error catch after its grant is revoked", async () => {
  const { digest } = await import("../src/auth/crypto");
  const { beginCommand, commitCommand, replayCommand } = await import(
    "../src/platform/household-command"
  );
  const first = await exports.default.fetch(
    request("/items", { name: "Rice" }),
  );
  const accepted = await first.json<{ data: { item: { id: string } } }>();
  const context: import("../src/platform/context").CommandContext = {
    householdId: "home",
    actorId: "local-owner",
    actorType: "member",
    source: "pwa",
    operationId: "authority-operation",
    authority: {
      householdId: "home",
      memberId: "local-owner",
      role: "owner",
      proof: {
        kind: "browser",
        tokenHash: await digest(cookie.split("=")[1]!),
        credentialVersion: 1,
      },
    },
  };
  const command = await beginCommand(
    env.DB,
    context,
    "inventory_item",
    "inventory.item.created",
    undefined,
    { name: "Rice" },
  );
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await env.DB.prepare("DELETE FROM auth_sessions").run();
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    commitCommand(
      database,
      command,
      {},
      accepted.data.item.id,
      new Date().toISOString(),
      [],
      async () => {},
    ),
  ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  await expect(replayCommand(env.DB, command)).rejects.toMatchObject({
    status: 403,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM household_command_receipts",
    ).first<number>("n"),
  ).toBe(1);
});

it("refuses delayed sync acceptance after exact grant revocation", async () => {
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          await env.DB.prepare("DELETE FROM auth_sessions").run();
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await worker.fetch(
    request("/sync", {
      cursor: 0,
      operations: [
        {
          operationId: "sync-authority-op",
          householdId: "home",
          deviceId: "sync-device",
          kind: "inventory.create",
          entityId: "sync-authority-item",
          expectedVersion: 0,
          clientTime: new Date().toISOString(),
          payload: { name: "Delayed" },
        },
      ],
    }),
    { ...env, DB: database },
  );
  expect(response.status).toBe(403);
  expect(
    await env.DB.prepare(
      "SELECT id FROM inventory_items WHERE id = 'sync-authority-item'",
    ).first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT operation_id FROM household_command_receipts WHERE operation_id = 'sync-authority-op'",
    ).first(),
  ).toBeNull();
});

it.each(["success", "version conflicts", "receipt conflicts"])(
  "keeps two-operation sync with a large projection within fifty D1 calls: %s",
  async (mode) => {
    const { countedD1 } = await import("./d1-budget");
    await env.DB.batch(
      Array.from({ length: 70 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO inventory_items (id, household_id, name, normalized_name, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, restock_interval_days, created_at, updated_at) VALUES (?, 'home', ?, ?, 'Kitchen', 'item', 'simple', 0, 'low', 25, 0, 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        ).bind(`budget-${index}`, `Item ${index}`, `item ${index}`),
      ),
    );
    if (mode === "receipt conflicts") {
      for (let index = 0; index < 2; index++)
        expect(
          (
            await exports.default.fetch(
              request(
                "/items",
                { name: `Before ${index}` },
                `budget-op-${index}`,
              ),
            )
          ).status,
        ).toBe(201);
    }
    const operations = Array.from({ length: 2 }, (_, index) => ({
      operationId: `budget-op-${index}`,
      householdId: "home",
      deviceId: "budget-device",
      kind:
        mode === "version conflicts" ? "inventory.update" : "inventory.create",
      entityId:
        mode === "version conflicts"
          ? `budget-${index}`
          : `budget-new-${index}`,
      expectedVersion: mode === "version conflicts" ? 99 : 0,
      clientTime: new Date().toISOString(),
      payload: { name: `After ${index}`, restockIntervalDays: 7 },
    }));
    const counted = countedD1(env.DB);
    const response = await worker.fetch(
      request("/sync", { cursor: 0, operations }),
      { ...env, DB: counted.database },
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: { results: { status: string }[]; items: unknown[] };
    }>();
    expect(body.data.results.map((result) => result.status)).toEqual([
      mode === "success" ? "accepted" : "conflict",
      mode === "success" ? "accepted" : "conflict",
    ]);
    expect(body.data.items.length).toBeGreaterThanOrEqual(70);
    expect(counted.calls()).toBeLessThanOrEqual(50);
    // Measured with 70+ projected items: success 20, stale-version batch 36, receipt conflict 14.
  },
);

it("rejects more than the two operations whose full sync budget has been measured", async () => {
  const operations = Array.from({ length: 3 }, (_, index) => ({
    operationId: `over-budget-${index}`,
    householdId: "home",
    deviceId: "budget",
    kind: "inventory.create",
    entityId: `over-budget-${index}`,
    expectedVersion: 0,
    clientTime: new Date().toISOString(),
    payload: { name: "Rice" },
  }));
  expect(
    (await exports.default.fetch(request("/sync", { cursor: 0, operations })))
      .status,
  ).toBe(400);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM inventory_items",
    ).first<number>("n"),
  ).toBe(0);
});

it.each(["revoked", "replaced", "deactivated"])(
  "keeps a reminder unread when its viewer-compatible personal grant is %s at acceptance",
  async (reason) => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES ('other-owner', 'home', 'Other owner', 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      ),
      env.DB.prepare(
        "UPDATE members SET role = 'viewer' WHERE id = 'local-owner'",
      ),
      env.DB.prepare(
        "INSERT INTO meals (id, household_id, title, cooking_at, timezone, reminder_at, recipes_json, created_at, updated_at) VALUES ('notice-meal', 'home', 'Dinner', '2090-01-01T12:00:00Z', 'Asia/Kolkata', ?, '[]', ?, ?)",
      ).bind(now, now, now),
      env.DB.prepare(
        "INSERT INTO notifications (id, household_id, member_id, title, body, meal_id, announcement_version, url, created_at) VALUES ('notice-id', 'home', 'local-owner', 'Dinner', 'Answer', 'notice-meal', 1, '/', ?)",
      ).bind(now),
    ]);
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare(
              reason === "revoked"
                ? "DELETE FROM auth_sessions"
                : reason === "replaced"
                  ? "UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'local-owner'"
                  : "UPDATE members SET archived_at = CURRENT_TIMESTAMP WHERE id = 'local-owner'",
            ).run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      new Request(request("/notifications/notice-id", { read: true }), {
        method: "PATCH",
      }),
      { ...env, DB: database },
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT read_at FROM notifications WHERE id = 'notice-id'",
      ).first<string>("read_at"),
    ).toBeNull();
  },
);
