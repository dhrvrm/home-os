import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import type { LedgerEntry } from "./types";
import { EntryDialog } from "./entry-dialog";
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "a@example.com" };
const members = [{ id: "alice", name: "Alice", active: true }, { id: "bob", name: "Bob", active: true }, { id: "viewer", name: "Viewer", active: true }];
beforeEach(async () => { localStorage.clear(); setActiveMemberId(user.id); publishAccessBoundary("ready", user); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(async () => { cleanup(); await homeOSDatabase.householdCache.clear(); vi.unstubAllGlobals(); });
function fillEqual() { fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Dinner" } }); fireEvent.change(screen.getByLabelText("Bill amount"), { target: { value: "100" } }); fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "100" } }); for (const name of ["Alice", "Bob", "Viewer"]) fireEvent.click(screen.getByRole("checkbox", { name })); }
it("shows exact equal shares, payer remainder, dirty-dismiss choice and a durable frozen save after response loss", async () => {
  const close = vi.fn(); render(<EntryDialog user={user} members={members} onClose={close} onAccepted={vi.fn()} />);
  await screen.findByLabelText("Description"); fillEqual();
  expect(screen.getByLabelText("Share for Alice")).toHaveTextContent("₹33.34");
  expect(screen.getByLabelText("Share for Bob")).toHaveTextContent("₹33.33");
  expect(screen.getByText("Payer difference · ₹0.00")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Discard this unsaved draft?")).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
  expect(await screen.findByRole("heading", { name: "Save outcome unknown" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Description")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Replay same save" })).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup();
  render(<EntryDialog user={user} members={members} onClose={close} onAccepted={vi.fn()} />);
  expect(await screen.findByRole("heading", { name: "Save outcome unknown" })).toHaveFocus();
  expect(screen.queryByLabelText("Description")).not.toBeInTheDocument();
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
});
it("opens duplicate as today's unsaved draft and blocks departed parties until corrected", async () => {
  const entry: LedgerEntry = { id: "old", householdId: "home", version: 2, lifecycle: "effective", intent: { kind: "expense", description: "Old bill", date: "2020-01-01", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }, { memberId: "departed", kind: "equal" }] } } }, payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "departed", amountMinor: 5000 }], createdAt: "", updatedAt: "" };
  render(<EntryDialog user={user} members={[...members, { id: "departed", name: "Former member", active: false }]} entry={entry} duplicate onAccepted={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByLabelText("Date")).toHaveValue(new Date().toLocaleDateString("en-CA"));
  expect(screen.getByRole("button", { name: "Save expense" })).toBeDisabled();
  expect(screen.getByText(/Replace or remove departed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: /Former member/ }));
  expect(screen.getByRole("button", { name: "Save expense" })).toBeEnabled();
});
it("requires currency review and never performs FX or reinterprets old minor units", async () => {
  render(<EntryDialog user={user} members={members} onAccepted={vi.fn()} onClose={vi.fn()} />); await screen.findByLabelText("Description"); fillEqual();
  fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "JPY" } });
  expect(screen.getByLabelText("Bill amount")).toHaveValue("100");
  expect(screen.getByRole("button", { name: "Save expense" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "I reviewed the amounts" }));
  expect(screen.getByLabelText("Share for Alice")).toHaveTextContent("JP¥34");
  expect(screen.getByRole("button", { name: "Save expense" })).toBeEnabled();
});
it("retains the original accepted outcome even if the consumer's subsequent refresh fails", async () => {
  const accepted = vi.fn(() => { throw new Error("refresh failed"); });
  render(<EntryDialog user={user} members={members} onAccepted={accepted} onClose={vi.fn()} />); await screen.findByLabelText("Description"); fillEqual();
  vi.mocked(fetch).mockImplementationOnce(async (_path, init) => { const intent = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ data: { status: "accepted", entry: { id: "saved", householdId: "home", version: 1, lifecycle: "effective", intent, payers: intent.payers, shares: [{ memberId: "alice", amountMinor: 3334 }, { memberId: "bob", amountMinor: 3333 }, { memberId: "viewer", amountMinor: 3333 }], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" } }, error: null }), { status: 201 }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save expense" })); });
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(screen.getByText(/Saved. The latest view could not refresh/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save expense" })).not.toBeInTheDocument();
});
it("exposes exact, percent and weighted remainder controls in a mixed preview", async () => {
  render(<EntryDialog user={user} members={[...members, { id: "dave", name: "Dave", active: true }]} onAccepted={vi.fn()} onClose={vi.fn()} />); await screen.findByLabelText("Description");
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Mixed bill" } }); fireEvent.change(screen.getByLabelText("Bill amount"), { target: { value: "1000" } }); fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "1000" } });
  fireEvent.change(screen.getByLabelText("Who shares split mode"), { target: { value: "mixed" } });
  for (const name of ["Alice", "Bob", "Viewer", "Dave"]) fireEvent.click(screen.getByRole("checkbox", { name }));
  fireEvent.change(screen.getByLabelText("Rule for Alice"), { target: { value: "fixed" } }); fireEvent.change(screen.getByLabelText("Who shares amount for Alice"), { target: { value: "200" } });
  fireEvent.change(screen.getByLabelText("Rule for Bob"), { target: { value: "percent" } }); fireEvent.change(screen.getByLabelText("Percent for Bob"), { target: { value: "30" } });
  for (const [name, weight] of [["Viewer", "1"], ["Dave", "3"]]) { fireEvent.change(screen.getByLabelText(`Rule for ${name}`), { target: { value: "weight" } }); fireEvent.change(screen.getByLabelText(`Weight for ${name}`), { target: { value: weight } }); }
  for (const [name, expected] of [["Alice", "₹200.00"], ["Bob", "₹300.00"], ["Viewer", "₹125.00"], ["Dave", "₹375.00"]]) expect(screen.getByLabelText(`Share for ${name}`)).toHaveTextContent(expected);
  expect(screen.getByRole("button", { name: "Save expense" })).toBeEnabled();
});
it("explains item quantities, per-line assignments and discount-before-tax/tip adjustments", async () => {
  render(<EntryDialog user={user} members={members} onAccepted={vi.fn()} onClose={vi.fn()} />); await screen.findByLabelText("Description");
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Itemized bill" } }); fireEvent.change(screen.getByLabelText("Amount mode"), { target: { value: "itemized" } });
  fireEvent.change(screen.getByLabelText("Item 1 label"), { target: { value: "Food" } }); fireEvent.change(screen.getByLabelText("Item 1 unit amount"), { target: { value: "300" } }); fireEvent.click(within(screen.getByRole("group", { name: "Item 1 shares" })).getByRole("checkbox", { name: "Alice" }));
  fireEvent.click(screen.getByRole("button", { name: "Add item · 1/40" }));
  fireEvent.change(screen.getByLabelText("Item 2 label"), { target: { value: "Supplies" } }); fireEvent.change(screen.getByLabelText("Item 2 unit amount"), { target: { value: "700" } }); fireEvent.click(within(screen.getByRole("group", { name: "Item 2 shares" })).getByRole("checkbox", { name: "Bob" }));
  fireEvent.change(screen.getByLabelText("Discount amount"), { target: { value: "100" } }); fireEvent.change(screen.getByLabelText("Tax type"), { target: { value: "percent" } }); fireEvent.change(screen.getByLabelText("Tax percent"), { target: { value: "10" } }); fireEvent.change(screen.getByLabelText("Tip amount"), { target: { value: "90" } }); fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "1080" } });
  expect(screen.getByText("Total · ₹1,080.00")).toBeInTheDocument(); expect(screen.getByLabelText("Share for Alice")).toHaveTextContent("₹324.00"); expect(screen.getByLabelText("Share for Bob")).toHaveTextContent("₹756.00");
  expect(screen.getByText(/Discount comes first/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Save expense" })).toBeEnabled();
});
it("keeps one focus scope for calculator Escape and protects dirty Escape/backdrop dismissal", async () => {
  const close = vi.fn(); render(<EntryDialog user={user} members={members} onAccepted={vi.fn()} onClose={close} />); await screen.findByLabelText("Description");
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this" } });
  fireEvent.click(screen.getByRole("button", { name: "Calculate Bill amount" }));
  fireEvent.keyDown(screen.getByLabelText("Calculation for Bill amount"), { key: "Escape" });
  expect(screen.queryByText("Discard this unsaved draft?")).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByText("Discard this unsaved draft?")).toBeInTheDocument(); expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
  expect(screen.getByText("Discard this unsaved draft?")).toBeInTheDocument(); expect(close).not.toHaveBeenCalled();
});
it("preserves an item's recorded participant order and a correction's observed version across source refresh", async () => {
  const entry: LedgerEntry = { id: "itemized", householdId: "home", version: 3, lifecycle: "effective", intent: { kind: "expense", date: "2026-11-19", description: "Small bill", currency: "INR", totalMinor: 199, payers: [{ memberId: "alice", amountMinor: 199 }], allocation: { kind: "itemized", participantOrder: ["bob", "alice"], items: [{ label: "A", quantity: "1", unitPriceMinor: 100, split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }] } }, { label: "B", quantity: "1", unitPriceMinor: 100, split: { mode: "equal", participants: [{ memberId: "bob", kind: "equal" }] } }], discount: { kind: "fixed", amountMinor: 1 } } }, payers: [{ memberId: "alice", amountMinor: 199 }], shares: [{ memberId: "bob", amountMinor: 99 }, { memberId: "alice", amountMinor: 100 }], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" };
  const props = { user, members, entry, onAccepted: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<EntryDialog {...props} />); await screen.findByLabelText("Description");
  expect(screen.getByLabelText("Share for Bob")).toHaveTextContent("₹0.99"); expect(screen.getByLabelText("Share for Alice")).toHaveTextContent("₹1.00");
  rerender(<EntryDialog {...props} entry={{ ...entry, version: 4 }} />);
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByRole("heading", { name: "Save outcome unknown" });
  expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ "If-Match": "3" }) });
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).allocation.participantOrder).toEqual(["bob", "alice"]);
});
it("retains editable input and focuses an ordinary initial validation refusal", async () => {
  render(<EntryDialog user={user} members={members} onAccepted={vi.fn()} onClose={vi.fn()} />); await screen.findByLabelText("Description"); fillEqual();
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "invalid_request", message: "Review this description" } }), { status: 400 }));
  fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Review this description"); expect(screen.getByRole("alert")).toHaveFocus();
  expect(screen.getByLabelText("Description")).toHaveValue("Dinner"); expect(screen.getByLabelText("Bill amount")).toHaveValue("100"); expect(screen.getByRole("button", { name: "Save expense" })).toBeEnabled();
});
