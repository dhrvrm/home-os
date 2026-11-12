import { authenticatedFetch } from "./authenticated-worker";
import { describe, expect, it } from "vitest";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return authenticatedFetch(new Request(`https://home-os.test${path}`, init));
}

interface RuleBody {
  id: string;
  version: number;
  amountMinor: number;
  needsAttention: boolean;
  archivedAt: string | null;
  participants: Array<{ memberId: string; shareMinor: number; memberActive: boolean }>;
}

describe("recurring expenses HTTP API", () => {
  it("creates, replays, revises, archives, and restores a rule", async () => {
    const createBody = {
      name: "Electricity",
      amountMinor: 5000,
      currency: "INR",
      cadence: { unit: "month", interval: 1, anchorDate: "2026-01-01" },
      participants: [{ memberId: "local-owner" }],
    };
    const createHeaders = {
      "Content-Type": "application/json",
      "X-Operation-ID": "api-create-electricity",
      "X-Device-ID": "api-test",
      "X-Client-Time": "2026-09-14T10:00:00.000Z",
    };

    const created = await api("/api/v1/expenses", {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    const createdEnvelope = await created.json<{ data: { rule: RuleBody } }>();
    const ruleId = createdEnvelope.data.rule.id;
    expect(createdEnvelope.data.rule).toMatchObject({
      version: 1,
      amountMinor: 5000,
      needsAttention: false,
      participants: [{ memberId: "local-owner", shareMinor: 5000, memberActive: true }],
    });

    const replayed = await api("/api/v1/expenses", {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(createBody),
    });
    expect(replayed.status).toBe(201);
    await expect(replayed.json()).resolves.toMatchObject({ data: { rule: { id: ruleId } } });

    const listed = await api("/api/v1/expenses");
    expect(listed.status).toBe(200);
    const listedEnvelope = await listed.json<{ data: { rules: RuleBody[] } }>();
    expect(listedEnvelope.data.rules.map((rule) => rule.id)).toContain(ruleId);

    const revised = await api(`/api/v1/expenses/${ruleId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "api-revise-electricity",
        "If-Match": "1",
      },
      body: JSON.stringify({ amountMinor: 6000 }),
    });
    expect(revised.status).toBe(200);
    await expect(revised.json()).resolves.toMatchObject({
      data: { rule: { version: 2, amountMinor: 6000, participants: [{ shareMinor: 6000 }] } },
    });

    const stale = await api(`/api/v1/expenses/${ruleId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "api-stale-electricity",
        "If-Match": "1",
      },
      body: JSON.stringify({ amountMinor: 7000 }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      data: null,
      error: { code: "conflict", details: { id: ruleId, version: 2, amountMinor: 6000 } },
    });

    const archived = await api(`/api/v1/expenses/${ruleId}`, {
      method: "DELETE",
      headers: { "X-Operation-ID": "api-archive-electricity", "If-Match": "2" },
    });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ data: { rule: { version: 3 } } });

    const defaultList = await api("/api/v1/expenses");
    const defaultEnvelope = await defaultList.json<{ data: { rules: RuleBody[] } }>();
    expect(defaultEnvelope.data.rules.map((rule) => rule.id)).not.toContain(ruleId);

    const archivedOnly = await api("/api/v1/expenses?archived=only");
    const archivedEnvelope = await archivedOnly.json<{ data: { rules: RuleBody[] } }>();
    expect(archivedEnvelope.data.rules.map((rule) => rule.id)).toContain(ruleId);

    const restored = await api(`/api/v1/expenses/${ruleId}/restore`, {
      method: "POST",
      headers: { "X-Operation-ID": "api-restore-electricity", "If-Match": "3" },
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      data: { rule: { archivedAt: null, version: 4 } },
    });

    const fetched = await api(`/api/v1/expenses/${ruleId}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({ data: { rule: { id: ruleId, version: 4 } } });

    const activity = await api(`/api/v1/activity?entityType=expense_rule&entityId=${ruleId}`);
    expect(activity.status).toBe(200);
    const activityEnvelope = await activity.json<{ data: { events: Array<{ action: string }> } }>();
    expect(activityEnvelope.data.events.map((event) => event.action)).toEqual([
      "expenses.rule.created",
      "expenses.rule.updated",
      "expenses.rule.archived",
      "expenses.rule.restored",
    ]);
  });

  it("returns stable validation and not-found envelopes", async () => {
    const unresolvable = await api("/api/v1/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Operation-ID": "api-unresolvable" },
      body: JSON.stringify({
        name: "Impossible split",
        amountMinor: 5000,
        cadence: { unit: "month", interval: 1, anchorDate: "2026-01-01" },
        participants: [{ memberId: "local-owner", override: { kind: "fixed", amountMinor: 6000 } }],
      }),
    });
    expect(unresolvable.status).toBe(400);
    await expect(unresolvable.json()).resolves.toMatchObject({
      data: null,
      error: { code: "invalid_request", field: "participants" },
    });

    const missing = await api("/api/v1/expenses/missing");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ data: null, error: { code: "not_found" } });
  });
});
