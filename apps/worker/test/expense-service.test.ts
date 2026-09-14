import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1ExpenseRepository } from "../src/expenses/catalog/d1-repository";
import { ExpenseService } from "../src/expenses/catalog/service";
import type { CreateExpenseInput } from "../src/expenses/catalog/model";
import type { CommandContext } from "../src/platform/context";
import { ConflictError, ValidationError } from "../src/platform/errors";

const HOUSEHOLD_ID = "home";
const database = (env as unknown as { DB: D1Database }).DB;

function service(): ExpenseService {
  return new ExpenseService(new D1ExpenseRepository(database));
}

function context(operationId: string, expectedVersion?: number): CommandContext {
  return {
    householdId: HOUSEHOLD_ID,
    actorId: "local-owner",
    actorType: "member",
    source: "pwa",
    operationId,
    expectedVersion,
    deviceId: "service-test",
  };
}

/** Tests share one database, so each takes its own member and rule name. */
async function partnerFor(scenario: string): Promise<string> {
  const memberId = `partner-${scenario}`;
  await database
    .prepare(
      `INSERT OR IGNORE INTO members (id, household_id, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, 'member', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .bind(memberId, HOUSEHOLD_ID, `Partner ${scenario}`)
    .run();
  return memberId;
}

function rentInput(partnerId: string, overrides: Partial<CreateExpenseInput> = {}): CreateExpenseInput {
  return {
    name: "Rent",
    amountMinor: 3000,
    currency: "INR",
    cadence: { unit: "month", interval: 1, anchorDate: "2026-01-01" },
    participants: [{ memberId: "local-owner" }, { memberId: partnerId }],
    ...overrides,
  };
}

async function auditActions(ruleId: string): Promise<string[]> {
  const result = await database
    .prepare(
      `SELECT action FROM audit_events
        WHERE household_id = ? AND entity_type = 'expense_rule' AND entity_id = ?
        ORDER BY sequence ASC`,
    )
    .bind(HOUSEHOLD_ID, ruleId)
    .all<{ action: string }>();
  return result.results.map((row) => row.action);
}

async function latestChanges(ruleId: string): Promise<unknown> {
  const row = await database
    .prepare(
      `SELECT changes_json FROM audit_events
        WHERE household_id = ? AND entity_type = 'expense_rule' AND entity_id = ?
        ORDER BY sequence DESC LIMIT 1`,
    )
    .bind(HOUSEHOLD_ID, ruleId)
    .first<{ changes_json: string }>();
  return JSON.parse(row!.changes_json) as unknown;
}

async function listedIds(archived: "exclude" | "only" | "include"): Promise<string[]> {
  const rules = await service().listRules(HOUSEHOLD_ID, { archived });
  return rules.map((rule) => rule.id);
}

describe("expense catalog service", () => {
  it("creates a rule with equal resolved shares at version 1", async () => {
    const partner = await partnerFor("equal");
    const rule = await service().createRule(context("create-rent"), rentInput(partner));
    expect(rule).toMatchObject({ name: "Rent", amountMinor: 3000, version: 1, needsAttention: false });
    expect(rule.participants).toEqual([
      { memberId: "local-owner", override: null, shareMinor: 1500, memberActive: true },
      { memberId: partner, override: null, shareMinor: 1500, memberActive: true },
    ]);
  });

  it("rejects a participant who is not a household member", async () => {
    const partner = await partnerFor("unknown");
    const failure = service().createRule(
      context("create-unknown-member"),
      rentInput(partner, { participants: [{ memberId: "local-owner" }, { memberId: "stranger" }] }),
    );
    await expect(failure).rejects.toBeInstanceOf(ValidationError);
    await expect(failure).rejects.toMatchObject({ field: "participants" });
  });

  it("rejects a split the resolver cannot resolve", async () => {
    const partner = await partnerFor("unresolvable");
    const failure = service().createRule(
      context("create-unresolvable"),
      rentInput(partner, {
        participants: [
          { memberId: "local-owner", override: { kind: "fixed", amountMinor: 6000 } },
          { memberId: partner },
        ],
      }),
    );
    await expect(failure).rejects.toBeInstanceOf(ValidationError);
    await expect(failure).rejects.toMatchObject({
      field: "participants",
      message: expect.stringContaining("overrides_exceed_total"),
    });
  });

  it("rejects an unknown currency and honours zero-minor-unit currencies", async () => {
    const partner = await partnerFor("currency");
    await expect(
      service().createRule(context("create-bad-currency"), rentInput(partner, { currency: "XYZ" })),
    ).rejects.toMatchObject({ field: "currency" });

    const yen = await service().createRule(
      context("create-yen"),
      rentInput(partner, { name: "Tokyo storage", currency: "JPY", amountMinor: 1000 }),
    );
    expect(yen.currency).toBe("JPY");
    expect(yen.participants.map((participant) => participant.shareMinor)).toEqual([500, 500]);
  });

  it("rejects a malformed cadence", async () => {
    const partner = await partnerFor("cadence");
    await expect(
      service().createRule(
        context("create-bad-interval"),
        rentInput(partner, { cadence: { unit: "month", interval: 0, anchorDate: "2026-01-01" } }),
      ),
    ).rejects.toMatchObject({ field: "cadence" });

    await expect(
      service().createRule(
        context("create-bad-anchor"),
        rentInput(partner, { cadence: { unit: "month", interval: 1, anchorDate: "2026-02-31" } }),
      ),
    ).rejects.toMatchObject({ field: "cadence" });
  });

  it("replays a repeated operation identity to the same stored result", async () => {
    const partner = await partnerFor("replay");
    const input = rentInput(partner, { name: "Replayed water bill" });
    const first = await service().createRule(context("create-once"), input);
    const second = await service().createRule(context("create-once"), input);
    expect(second).toEqual(first);

    const rules = await service().listRules(HOUSEHOLD_ID);
    expect(rules.filter((rule) => rule.name === "Replayed water bill")).toHaveLength(1);
  });

  it("refuses a stale revision and reports the current rule", async () => {
    const partner = await partnerFor("conflict");
    const created = await service().createRule(context("create-for-conflict"), rentInput(partner));
    await service().updateRule(context("revise-first", 1), created.id, { amountMinor: 4000 });

    const stale = service().updateRule(context("revise-stale", 1), created.id, { amountMinor: 5000 });
    await expect(stale).rejects.toBeInstanceOf(ConflictError);
    await expect(stale).rejects.toMatchObject({
      expectedVersion: 1,
      actualVersion: 2,
      details: { id: created.id, version: 2, amountMinor: 4000 },
    });
  });

  it("re-resolves shares on revision and audits exactly the changed fields", async () => {
    const partner = await partnerFor("revision");
    const created = await service().createRule(context("create-for-revision"), rentInput(partner));
    const revised = await service().updateRule(context("revise-amount", 1), created.id, {
      amountMinor: 5000,
    });

    expect(revised.version).toBe(2);
    expect(revised.participants.map((participant) => participant.shareMinor)).toEqual([2500, 2500]);
    expect(await latestChanges(created.id)).toEqual([
      { op: "replace", path: "/amountMinor", oldValue: 3000, value: 5000 },
    ]);
  });

  it("archives and restores a rule, versioned and audited", async () => {
    const partner = await partnerFor("archive");
    const created = await service().createRule(context("create-for-archive"), rentInput(partner));

    const archived = await service().archiveRule(context("archive-rent", 1), created.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.version).toBe(2);
    expect(await listedIds("exclude")).not.toContain(created.id);
    expect(await listedIds("only")).toContain(created.id);

    const restored = await service().restoreRule(context("restore-rent", 2), created.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.version).toBe(3);
    expect(await listedIds("exclude")).toContain(created.id);

    expect(await auditActions(created.id)).toEqual([
      "expenses.rule.created",
      "expenses.rule.archived",
      "expenses.rule.restored",
    ]);
  });

  it("flags a rule whose participant was archived without breaking its shares", async () => {
    const partner = await partnerFor("departed");
    const created = await service().createRule(
      context("create-for-archived-member"),
      rentInput(partner),
    );
    await database
      .prepare("UPDATE members SET archived_at = ? WHERE id = ?")
      .bind("2026-06-01T00:00:00.000Z", partner)
      .run();

    const rule = await service().getRule(HOUSEHOLD_ID, created.id);
    expect(rule.needsAttention).toBe(true);
    expect(rule.participants).toEqual([
      { memberId: "local-owner", override: null, shareMinor: 1500, memberActive: true },
      { memberId: partner, override: null, shareMinor: 1500, memberActive: false },
    ]);

    const revised = await service().updateRule(context("revise-flagged", 1), created.id, {
      name: "Rent (review split)",
    });
    expect(revised.name).toBe("Rent (review split)");
    expect(revised.needsAttention).toBe(true);
  });

  it("attaches resolved shares to every listed rule", async () => {
    const partner = await partnerFor("listing");
    const rent = await service().createRule(context("create-list-rent"), rentInput(partner));
    const internet = await service().createRule(
      context("create-list-internet"),
      rentInput(partner, { name: "Internet", amountMinor: 1000 }),
    );

    const rules = await service().listRules(HOUSEHOLD_ID);
    expect(rules.map((rule) => rule.id)).toEqual(expect.arrayContaining([rent.id, internet.id]));
    for (const rule of rules) {
      const total = rule.participants.reduce((sum, participant) => sum + participant.shareMinor, 0);
      expect(total).toBe(rule.amountMinor);
    }
  });
});
