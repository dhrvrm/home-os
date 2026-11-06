import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveInventoryCache } from "@/lib/inventory-cache";
import type { InventoryItem } from "@/lib/inventory";
import { homeOSDatabase } from "@/offline/db";
import { InventoryApp } from "./inventory-app";
import type { AuthSession } from "@/lib/auth";
import { createLocalItem } from "@/offline/commands";
import * as pwaState from "./pwa-state";

const memberSession: AuthSession = { user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "member" }, expiresAt: "2099-12-01T00:00:00.000Z" };

const soap: InventoryItem = {
  id: "soap",
  name: "Dish soap",
  alternativeNames: ["साबुन", "Soap"],
  category: "Cleaning",
  categories: ["Cleaning", "Kitchen"],
  location: "Kitchen",
  unit: "bottle",
  trackingMode: "simple",
  quantity: 0,
  stockLevel: "low",
  levelPercent: 25,
  minQuantity: 0,
  cadence: {
    averageIntervalDays: 4,
    eventsPerWeek: 1.8,
    lastConsumedAt: "2026-08-22T10:00:00Z",
    confidence: "low",
  },
  createdAt: "2026-08-24T10:00:00Z",
  updatedAt: "2026-08-24T10:00:00Z",
};

const rice: InventoryItem = {
  id: "rice",
  name: "Rice",
  alternativeNames: ["चावल"],
  category: "Food",
  categories: ["Food", "Staples"],
  location: "Pantry",
  unit: "kg",
  trackingMode: "exact",
  quantity: 3,
  stockLevel: "okay",
  levelPercent: 0,
  minQuantity: 1,
  createdAt: "2026-08-24T10:00:00Z",
  updatedAt: "2026-08-24T10:00:00Z",
};

const milk: InventoryItem = {
  id: "milk",
  name: "Milk",
  alternativeNames: [],
  category: "Food",
  categories: ["Food"],
  location: "Fridge",
  unit: "litre",
  trackingMode: "exact",
  quantity: 2,
  stockLevel: "okay",
  levelPercent: 0,
  minQuantity: 1,
  restockIntervalDays: 7,
  restockDue: {
    intervalDays: 7,
    lastRestockedAt: "2026-08-15T10:00:00Z",
    daysSinceRestock: 9,
    dueInDays: -2,
    status: "overdue",
  },
  attentionReasons: ["overdue"],
  createdAt: "2026-08-01T10:00:00Z",
  updatedAt: "2026-08-24T10:00:00Z",
};

beforeEach(async () => {
  await homeOSDatabase.delete();
  await homeOSDatabase.open();
});

afterEach(async () => {
  cleanup();
  await homeOSDatabase.delete();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("InventoryApp", () => {
  it("closes an open write form when the member becomes a viewer without queuing its draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 })));
    const user = userEvent.setup();
    const { rerender } = render(<InventoryApp session={memberSession} />);
    expect(await screen.findByText("Dish soap")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByLabelText("Item name"), "Do not save after demotion");
    expect(screen.getByRole("dialog", { name: "Add an item" })).toBeInTheDocument();
    rerender(<InventoryApp session={{ ...memberSession, user: { ...memberSession.user, role: "viewer" } }} />);
    expect(screen.queryByRole("dialog", { name: "Add an item" })).not.toBeInTheDocument();
    expect(await homeOSDatabase.outbox.count()).toBe(0);
    expect(await homeOSDatabase.items.where("name").equals("Do not save after demotion").count()).toBe(0);
  });

  it("allows a waiting PWA update after a queued change becomes a retained conflict", async () => {
    await createLocalItem(homeOSDatabase, { name: "Conflict soap" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const snapshot = { canInstall: false, installed: true, ios: false, offlineReady: true, updateAvailable: true, updating: false, error: null };
    vi.spyOn(pwaState, "getPWAState").mockReturnValue(snapshot);
    render(<InventoryApp session={memberSession} onLogout={vi.fn()} onSessionChange={vi.fn()} />);
    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Account" }));
    const update = await screen.findByRole("button", { name: "Update and reload" });
    await waitFor(() => expect(update).toBeDisabled());
    await homeOSDatabase.outbox.toCollection().modify({ state: "conflict" });
    await waitFor(() => expect(update).toBeEnabled());
    expect((await homeOSDatabase.outbox.toArray())[0]?.state).toBe("conflict");
  });

  it("shows loading and then inventory", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    render(<InventoryApp />);
    expect(screen.getByText("Loading your home inventory")).toBeInTheDocument();
    await waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    resolveFetch(new Response(JSON.stringify({ data: { items: [soap, rice] }, error: null }), { status: 200 }));
    expect(await screen.findByText("Dish soap")).toBeInTheDocument();
    expect(screen.getByText("Rice")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Dish soap level" })).toHaveAttribute("value", "25");
    expect(screen.getByText("Used about every 4 days")).toBeInTheDocument();
    expect(screen.getByText("साबुन, Soap")).toBeInTheDocument();
  });

  it("shows a retryable API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<InventoryApp />);
    expect(await screen.findByText("Inventory could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("migrates a validated saved copy and keeps it editable offline", async () => {
    saveInventoryCache([soap], localStorage, new Date("2026-08-27T08:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = userEvent.setup();
    render(<InventoryApp />);

    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Add item" })) expect(button).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "View details for Dish soap" }));
    const details = screen.getByRole("dialog", { name: "Dish soap" });
    expect(details).toHaveFocus();
    expect(within(details).getByRole("button", { name: "Edit item" })).toBeEnabled();
    expect(within(details).getByRole("button", { name: "Adjust stock" })).toBeEnabled();
    expect(within(details).getByRole("button", { name: "Archive item" })).toBeEnabled();
    await user.click(within(details).getByRole("button", { name: "Close details for Dish soap" }));
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
  });

  it("keeps an empty saved inventory editable", async () => {
    saveInventoryCache([], localStorage, new Date("2026-08-27T08:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<InventoryApp />);

    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add first item" })).toBeEnabled();
  });

  it("keeps a loaded inventory writable when the browser goes offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 })));
    render(<InventoryApp />);
    await screen.findByText("Dish soap");

    window.dispatchEvent(new Event("offline"));

    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Dish soap" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restock Dish soap" })).toBeEnabled();
  });

  it("keeps an open write dialog usable when connectivity is lost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [] }, error: null }), { status: 200 })));
    const user = userEvent.setup();
    render(<InventoryApp />);
    await user.click(await screen.findByRole("button", { name: "Add first item" }));
    expect(screen.getByRole("dialog", { name: "Add an item" })).toBeInTheDocument();

    window.dispatchEvent(new Event("offline"));

    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add an item" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add first item" })).toBeEnabled();
  });

  it("queues a local change if the API disappears after startup", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockRejectedValueOnce(new Error("API stopped"));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Dish soap");

    await user.click(screen.getByRole("button", { name: "Restock Dish soap" }));

    expect(await screen.findByText("Saved on this device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Dish soap" })).toBeEnabled();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
  });

  it("filters by search and category", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [soap, rice] }, error: null }), { status: 200 })));
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Dish soap");
    await user.type(screen.getByRole("searchbox", { name: "Search inventory" }), "साबुन");
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
    expect(screen.queryByText("Rice")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search inventory" }));
    await user.click(screen.getByRole("button", { name: "Kitchen" }));
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
    expect(screen.queryByText("Rice")).not.toBeInTheDocument();
  });

  it("creates an item and adds it to the list", async () => {
    const created = { ...rice, alternativeNames: ["चावल", "Basmati"], category: "Cleaning", categories: ["Cleaning", "Kitchen"], trackingMode: "simple", levelPercent: 75 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: created }, error: null }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Your inventory is ready for its first item");
    await user.click(screen.getByRole("button", { name: "Add first item" }));
    const dialog = screen.getByRole("dialog", { name: "Add an item" });
    await user.type(within(dialog).getByLabelText("Item name"), "Rice");
    await user.type(within(dialog).getByLabelText("Alternative names"), "चावल, Basmati");
    await user.click(within(dialog).getByRole("checkbox", { name: "Food" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Cleaning" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Kitchen" }));
    fireEvent.change(within(dialog).getByRole("slider", { name: "Starting level" }), { target: { value: "75" } });
    await user.click(within(dialog).getByRole("button", { name: "Save item" }));
    expect(await screen.findByText("Rice")).toBeInTheDocument();
    const createRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(createRequest.body))).toMatchObject({
      trackingMode: "simple",
      levelPercent: 75,
      alternativeNames: ["चावल", "Basmati"],
      categories: ["Cleaning", "Kitchen"],
    });
  });

  it("contains dialog focus and restores it when closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [] }, error: null }), { status: 200 })));
    const user = userEvent.setup();
    render(<InventoryApp />);
    const opener = await screen.findByRole("button", { name: "Add first item" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Add an item" });
    const close = within(dialog).getByRole("button", { name: "Close add item" });
    const save = within(dialog).getByRole("button", { name: "Save item" });
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("*")).filter((element) => (
      element.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
    ));
    expect(focusable[focusable.length - 1]).toBe(save);
    save.focus();
    expect(fireEvent.keyDown(save, { key: "Tab" })).toBe(false);
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add an item" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("applies a stock action", async () => {
    const updated = { ...soap, stockLevel: "full", levelPercent: 100 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Dish soap");
    await user.click(screen.getByRole("button", { name: "Restock Dish soap" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Full")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("meter", { name: "Dish soap level" })).toHaveAttribute("value", "100"));
  });

  it("consumes 25 points from an approximate item", async () => {
    const updated = { ...soap, stockLevel: "out", levelPercent: 0 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Dish soap");
    await user.click(screen.getByRole("button", { name: "Use Dish soap" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const eventRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(eventRequest.body))).toMatchObject({ type: "consume", quantity: 25 });
    expect(await screen.findByText("0%")).toBeInTheDocument();
  });

  it("edits an item directly and displays immutable history", async () => {
    const updated = { ...rice, location: "Kitchen shelf" };
    const history = { id: "event-1", itemId: "rice", type: "consume", quantity: 0.5, stockLevel: "okay", levelPercent: 0, note: "Made dinner", occurredAt: "2026-08-26T10:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [rice] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { events: [history] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);

    await screen.findByText("Rice");
    await user.click(screen.getByRole("button", { name: "View details for Rice" }));
    const details = screen.getByRole("dialog", { name: "Rice" });
    expect(details).toHaveFocus();
    expect(fireEvent.keyDown(details, { key: "Tab", shiftKey: true })).toBe(false);
    expect(within(details).getByRole("button", { name: "Archive item" })).toHaveFocus();
    expect(await screen.findByText("Made dinner")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit item" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Rice" });
    await user.clear(within(dialog).getByLabelText("Location"));
    await user.type(within(dialog).getByLabelText("Location"), "Kitchen shelf");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({ location: "Kitchen shelf" });
  });

  it("accepts an exact consumption quantity", async () => {
    const updated = { ...rice, quantity: 0.5, stockLevel: "low" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [rice] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);

    await screen.findByText("Rice");
    await user.click(screen.getByRole("button", { name: "Use Rice" }));
    const dialog = screen.getByRole("dialog", { name: "Use Rice" });
    const quantity = within(dialog).getByLabelText("Quantity (kg)");
    await user.clear(quantity);
    await user.type(quantity, "2.5");
    await user.click(within(dialog).getByRole("button", { name: "Use stock" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({ type: "consume", quantity: 2.5 });
  });

  it("adjusts a simple item to an arbitrary meter level", async () => {
    const updated = { ...soap, levelPercent: 35, stockLevel: "okay" as const };
    const adjusted = { id: "event-adjust", itemId: "soap", type: "mark_level", quantity: 0, stockLevel: "okay", levelPercent: 35, note: "", occurredAt: "2026-08-27T10:00:00Z" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { events: [] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { events: [adjusted] }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);

    await screen.findByText("Dish soap");
    await user.click(screen.getByRole("button", { name: "View details for Dish soap" }));
    await user.click(await screen.findByRole("button", { name: "Adjust stock" }));
    const dialog = screen.getByRole("dialog", { name: "Adjust Dish soap" });
    fireEvent.change(within(dialog).getByRole("slider", { name: "Current level" }), { target: { value: "35" } });
    await user.click(within(dialog).getByRole("button", { name: "Adjust stock" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({ type: "mark_level", levelPercent: 35 });
    expect(await screen.findByText("Adjusted to 35%")).toBeInTheDocument();
  });

  it("turns low inventory into a functional shopping list", async () => {
    const updated = { ...soap, stockLevel: "full", levelPercent: 100 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: updated }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);

    await screen.findByText("Dish soap");
    await user.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name: "Shopping" }));
    expect(screen.getByRole("heading", { name: "Buy next" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restock Dish soap from shopping list" }));
    expect(await screen.findByText("Nothing needs buying")).toBeInTheDocument();
  });

  it("archives and restores an item without deleting it", async () => {
    const archived = { ...soap, archivedAt: "2026-08-27T08:00:00Z" };
    const restored = { ...soap, archivedAt: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [soap] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { events: [] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: archived }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: restored }, error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<InventoryApp />);

    await screen.findByText("Dish soap");
    await user.click(screen.getByRole("button", { name: "View details for Dish soap" }));
    await user.click(await screen.findByRole("button", { name: "Archive item" }));
    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await user.click(screen.getByRole("button", { name: "Active" }));
    expect(await screen.findByText("Dish soap")).toBeInTheDocument();
  });

  it("shows an overdue badge on the item row and counts it as needing attention", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { items: [milk] }, error: null }), { status: 200 }),
    ));
    render(<InventoryApp />);
    expect(await screen.findByText("Milk")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Restock overdue by 2 days")).toBeInTheDocument();
    const stats = screen.getByLabelText("Inventory summary");
    const attention = within(stats).getByText("Need attention").closest("div")!;
    expect(within(attention).getByText("1")).toBeInTheDocument();
  });

  it("includes interval-due items on the shopping list with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { items: [milk, rice] }, error: null }), { status: 200 }),
    ));
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Milk");
    await user.click(screen.getAllByRole("button", { name: "Shopping" })[0]);
    expect(await screen.findByText("Buy next")).toBeInTheDocument();
    const list = screen.getByRole("heading", { name: "Milk" }).closest("article")!;
    expect(within(list).getByText("Overdue")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Rice" })).not.toBeInTheDocument();
  });
});
