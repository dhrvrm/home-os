import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryApp } from "./inventory-app";

const soap = {
  id: "soap",
  name: "Dish soap",
  category: "Cleaning",
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

const rice = {
  id: "rice",
  name: "Rice",
  category: "Food",
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InventoryApp", () => {
  it("shows loading and then inventory", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    render(<InventoryApp />);
    expect(screen.getByText("Loading your home inventory")).toBeInTheDocument();
    resolveFetch(new Response(JSON.stringify({ data: { items: [soap, rice] }, error: null }), { status: 200 }));
    expect(await screen.findByText("Dish soap")).toBeInTheDocument();
    expect(screen.getByText("Rice")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Dish soap level" })).toHaveAttribute("value", "25");
    expect(screen.getByText("Used about every 4 days")).toBeInTheDocument();
  });

  it("shows a retryable API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<InventoryApp />);
    expect(await screen.findByText("Inventory could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("filters by search and category", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [soap, rice] }, error: null }), { status: 200 })));
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Dish soap");
    await user.type(screen.getByRole("searchbox", { name: "Search inventory" }), "rice");
    expect(screen.queryByText("Dish soap")).not.toBeInTheDocument();
    expect(screen.getByText("Rice")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search inventory" }));
    await user.click(screen.getByRole("button", { name: "Cleaning" }));
    expect(screen.getByText("Dish soap")).toBeInTheDocument();
    expect(screen.queryByText("Rice")).not.toBeInTheDocument();
  });

  it("creates an item and adds it to the list", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { items: [] }, error: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { item: rice }, error: null }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<InventoryApp />);
    await screen.findByText("Your inventory is ready for its first item");
    await user.click(screen.getByRole("button", { name: "Add first item" }));
    const dialog = screen.getByRole("dialog", { name: "Add an item" });
    await user.type(within(dialog).getByLabelText("Item name"), "Rice");
    fireEvent.change(within(dialog).getByRole("slider", { name: "Starting level" }), { target: { value: "75" } });
    await user.click(within(dialog).getByRole("button", { name: "Save item" }));
    expect(await screen.findByText("Rice")).toBeInTheDocument();
    const createRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(createRequest.body))).toMatchObject({ trackingMode: "simple", levelPercent: 75 });
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
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Dish soap level" })).toHaveAttribute("value", "100");
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
    expect(JSON.parse(String(eventRequest.body))).toEqual({ type: "consume", quantity: 25 });
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
