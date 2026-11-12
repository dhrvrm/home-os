import { afterEach, describe, expect, it, vi } from "vitest";
import { listExpenses, listItems, updateExpense, updateItemMetadata } from "./api";
import { captureAccessProof, publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); setActiveMemberId(null); resumeHouseholdWork(); });

describe("session failure scope", () => {
  it("does not turn a request from an old tab into global expiry before its storage event runs", async () => {
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "bob", householdId: "home" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: null, error: { code: "session_changed", message: "Member changed" } }), { status: 409 })));
    const expired = vi.fn();
    window.addEventListener("home-os:session-expired", expired);
    try {
      await expect(listItems()).rejects.toMatchObject({ code: "session_changed" });
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener("home-os:session-expired", expired); }
  });
  it.each([[401, "unauthorized"], [409, "session_changed"]])("ignores a stale HTTP%s from a superseded same-member grant", async (status, code) => {
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const expired = vi.fn();
    window.addEventListener("home-os:session-expired", expired);
    try {
      const result = listItems().catch((error: unknown) => error);
      publishAccessBoundary("ready", { id: "alice", householdId: "home" });
      finish(new Response(JSON.stringify({ data: null, error: { code, message: "Old request failed" } }), { status }));
      expect(await result).toMatchObject({ code });
      expect(expired).not.toHaveBeenCalled();
    } finally { window.removeEventListener("home-os:session-expired", expired); }
  });

  it("reports a current failed grant with its member and access generation", async () => {
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    const proof = captureAccessProof();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: null, error: { code: "unauthorized", message: "Sign in again" } }), { status: 401 })));
    const expired = vi.fn();
    window.addEventListener("home-os:session-expired", expired);
    try {
      await expect(listItems()).rejects.toMatchObject({ code: "unauthorized" });
      expect(expired).toHaveBeenCalledOnce();
      expect((expired.mock.calls[0][0] as CustomEvent).detail).toEqual(proof);
    } finally { window.removeEventListener("home-os:session-expired", expired); }
  });
});

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
