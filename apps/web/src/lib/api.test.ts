import { afterEach, describe, expect, it, vi } from "vitest";
import { updateItemMetadata } from "./api";

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
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8080/api/v1/items/soap", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Washing-up liquid", categories: ["Cleaning", "Kitchen"] }),
    }));
  });
});
