import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://home-os.test${path}`, init));
}

describe("household audit trail", () => {
  it("records append-only safe deltas with authoritative cursors", async () => {
    const created = await api("/api/v1/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "audit-create-soap",
        "X-Device-ID": "phone-1",
        "X-Client-Time": "2026-08-27T09:00:00.000Z",
      },
      body: JSON.stringify({ name: "Soap", categories: ["Cleaning"], levelPercent: 50 }),
    });
    const createdBody = await created.json<{ data: { item: { id: string } } }>();
    const itemId = createdBody.data.item.id;

    await api(`/api/v1/items/${itemId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Operation-ID": "audit-consume-soap",
        "X-Device-ID": "phone-1",
        "If-Match": "1",
      },
      body: JSON.stringify({ type: "consume" }),
    });

    const response = await api(`/api/v1/activity?entityType=inventory_item&entityId=${itemId}&limit=1`);
    expect(response.status).toBe(200);
    const envelope = await response.json<{
      data: {
        events: Array<{
          sequence: number;
          action: string;
          actorId: string;
          source: string;
          deviceId: string;
          operationId: string;
          changes: Array<{ path: string; oldValue: unknown; value: unknown }>;
        }>;
        nextCursor: string | null;
      };
    }>();
    expect(envelope.data.events).toHaveLength(1);
    expect(envelope.data.events[0]).toMatchObject({
      action: "inventory.item.created",
      actorId: "local-owner",
      source: "pwa",
      deviceId: "phone-1",
      operationId: "audit-create-soap",
    });
    expect(envelope.data.events[0]?.sequence).toBeGreaterThan(0);
    expect(envelope.data.nextCursor).not.toBeNull();

    const next = await api(
      `/api/v1/items/${itemId}/activity?after=${encodeURIComponent(envelope.data.nextCursor!)}&limit=100`,
    );
    const nextEnvelope = await next.json<{ data: { events: Array<{ action: string; changes: Array<{ path: string }> }> } }>();
    expect(nextEnvelope.data.events).toHaveLength(1);
    expect(nextEnvelope.data.events[0]).toMatchObject({ action: "inventory.stock.consume" });
    expect(nextEnvelope.data.events[0]?.changes.map((change) => change.path)).toEqual([
      "/stockLevel",
      "/levelPercent",
    ]);
  });
});
