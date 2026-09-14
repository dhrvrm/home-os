import { afterEach, describe, expect, it, vi } from "vitest";
import { listExpenses, listItems, updateExpense, updateItemMetadata } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("inventory metadata API", () => {
  it("sends a guarded PATCH and returns the updated item", async () => {
    const item = {
      id: "soap", name: "Washing-up liquid", alternativeNames: ["साबुन"], category: "Cleaning", categories: ["Cleaning", "Kitchen"],
      location: "Kitchen", unit: "bottle", trackingMode: "simple", quantity: 0, stockLevel: "low", levelPercent: 25, minQuantity: 0,
      createdAt: "2026-08-24T10:00:00Z", updatedAt: "2026-08-25T10:00:00Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { item }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateItemMetadata("soap", { name: "Washing-up liquid", categories: ["Cleaning", "Kitchen"] })).resolves.toEqual(item);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/items/soap", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Washing-up liquid", categories: ["Cleaning", "Kitchen"] }),
    }));
  });

  it("times out a stalled request with an actionable error code", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));

    await expect(listItems({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
      message: "The Home OS API took too long to respond. Try again.",
    });
  });

  it("keeps timeout protection active while the response body is loading", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    } as Response)));

    const outcome = await Promise.race([
      listItems({ timeoutMs: 1 }).catch((error: unknown) => error),
      new Promise((resolve) => window.setTimeout(() => resolve({ code: "body_hung" }), 25)),
    ]);

    expect(outcome).toMatchObject({ code: "timeout" });
  });
});

describe("recurring expenses API", () => {
  it("sends a guarded PATCH and returns the revised rule", async () => {
    const rule = { id: "electricity", version: 2, amountMinor: 6000 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { rule }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateExpense("electricity", { amountMinor: 6000 }, { expectedVersion: 1, operationId: "op-1" }),
    ).resolves.toEqual(rule);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/expenses/electricity", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({ "If-Match": "1", "X-Operation-ID": "op-1" }),
      body: JSON.stringify({ amountMinor: 6000 }),
    }));
  });

  it("surfaces a stale-version conflict as a conflict-coded error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: null, error: { code: "conflict", message: "This rule changed elsewhere." } }),
      { status: 409 },
    )));

    await expect(updateExpense("electricity", { amountMinor: 7000 }, { expectedVersion: 1 })).rejects.toMatchObject({
      code: "conflict",
      message: "This rule changed elsewhere.",
    });
  });

  it("requests archived rules when asked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { rules: [] }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listExpenses({ archived: "only" })).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/expenses?archived=only", expect.anything());
  });
});
