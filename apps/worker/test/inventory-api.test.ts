import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://home-os.test${path}`, init));
}

describe("inventory HTTP API", () => {
  it("preserves inventory behavior, idempotency, conflicts, lifecycle, and export", async () => {
    const createBody = {
      name: "Rice",
      alternativeNames: ["चावल", "Basmati"],
      categories: ["Food", "Staples"],
      location: "Pantry",
      unit: "kg",
      trackingMode: "exact",
      quantity: 5,
      minQuantity: 1,
    };
    const createHeaders = {
      "Content-Type": "application/json",
      "X-Operation-ID": "api-create-rice",
      "X-Device-ID": "api-test",
      "X-Client-Time": "2026-08-27T10:00:00.000Z",
    };

    const createdResponse = await api("/api/v1/items", {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(createBody),
    });
    expect(createdResponse.status).toBe(201);
    const createdEnvelope = await createdResponse.json<{
      data: { item: { id: string; version: number; alternativeNames: string[]; categories: string[] } };
    }>();
    const itemId = createdEnvelope.data.item.id;
    expect(createdEnvelope.data.item).toMatchObject({
      version: 1,
      alternativeNames: ["चावल", "Basmati"],
      categories: ["Food", "Staples"],
    });

    const replayResponse = await api("/api/v1/items", {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify(createBody),
    });
    expect(replayResponse.status).toBe(201);
    const replayEnvelope = await replayResponse.json<{ data: { item: { id: string } } }>();
    expect(replayEnvelope.data.item.id).toBe(itemId);

    const searched = await api("/api/v1/items?q=%E0%A4%9A%E0%A4%BE%E0%A4%B5%E0%A4%B2&category=Staples");
    expect(searched.status).toBe(200);
    const searchedEnvelope = await searched.json<{ data: { items: Array<{ id: string }> } }>();
    expect(searchedEnvelope.data.items.map((item) => item.id)).toEqual([itemId]);

    const updated = await api(`/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "api-update-rice",
        "If-Match": "1",
      },
      body: JSON.stringify({ name: "Basmati rice", categories: ["Food", "Staples", "Kitchen"] }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: { item: { name: "Basmati rice", version: 2, categories: ["Food", "Staples", "Kitchen"] } },
      error: null,
    });

    const stale = await api(`/api/v1/items/${itemId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "api-stale-rice",
        "If-Match": "1",
      },
      body: JSON.stringify({ name: "Stale name" }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ data: null, error: { code: "conflict" } });

    const consumed = await api(`/api/v1/items/${itemId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "api-consume-rice",
        "If-Match": "2",
      },
      body: JSON.stringify({ type: "consume", quantity: 1.5, note: "Dinner" }),
    });
    expect(consumed.status).toBe(201);
    await expect(consumed.json()).resolves.toMatchObject({
      data: { item: { quantity: 3.5, version: 3 } },
    });

    const events = await api(`/api/v1/items/${itemId}/events`);
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      data: { events: [{ type: "consume", quantity: 1.5, note: "Dinner" }] },
    });

    const archived = await api(`/api/v1/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-Operation-ID": "api-archive-rice", "If-Match": "3" },
    });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ data: { item: { version: 4 } } });

    const restored = await api(`/api/v1/items/${itemId}/restore`, {
      method: "POST",
      headers: { "X-Operation-ID": "api-restore-rice", "If-Match": "4" },
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ data: { item: { archivedAt: null, version: 5 } } });

    const exported = await api("/api/v1/export");
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      data: {
        version: 1,
        items: [{ item: { id: itemId }, events: [{ type: "consume" }] }],
      },
      error: null,
    });
  });

  it("returns stable validation and not-found envelopes", async () => {
    const invalid = await api("/api/v1/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Operation-ID": "api-invalid" },
      body: JSON.stringify({ name: " " }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      data: null,
      error: { code: "invalid_request", message: "enter an item name", field: "name" },
    });

    const missing = await api("/api/v1/items/missing");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ data: null, error: { code: "not_found" } });
  });
});
