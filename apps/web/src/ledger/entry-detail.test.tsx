import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import { EntryDetail } from "./entry-detail";
import type { LedgerEntry } from "./types";
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "alice@example.com" };
const members = [{ id: "alice", name: "Alice", active: true }, { id: "bob", name: "Bob", active: false }];
const entry: LedgerEntry = { id: "bill", householdId: "home", version: 2, lifecycle: "effective", intent: { kind: "expense", date: "2026-11-19", description: "Dinner", currency: "INR", totalMinor: 90000, payers: [{ memberId: "alice", amountMinor: 90000 }], notes: "Dinner notes", allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }, { memberId: "bob", kind: "equal" }] } } }, payers: [{ memberId: "alice", amountMinor: 90000 }], shares: [{ memberId: "alice", amountMinor: 45000 }, { memberId: "bob", amountMinor: 45000 }], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T01:00:00Z" };
const capacity = { expenseId: "bill", available: true, totalMinor: 90000, creditedMinor: 0, remainingMinor: 90000, payers: [{ memberId: "alice", originalMinor: 90000, creditedMinor: 0, remainingMinor: 90000 }], shares: [{ memberId: "alice", originalMinor: 45000, creditedMinor: 0, remainingMinor: 45000 }, { memberId: "bob", originalMinor: 45000, creditedMinor: 0, remainingMinor: 45000 }] };
beforeEach(async () => { setActiveMemberId(user.id); publishAccessBoundary("ready", user); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); });
afterEach(async () => { cleanup(); await homeOSDatabase.householdCache.clear(); vi.unstubAllGlobals(); });
function setup(write?: (path: string, init: RequestInit) => Promise<Response>) { const mock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => { if (init?.method && write)
    return write(String(path), init); const data = String(path).endsWith("/comments") || String(path).includes("/comments?") ? { items: [{ id: "c", entryId: "bill", observedVersion: 1, authorId: "bob", text: "Shared with everyone", acceptedAt: "2026-11-19T00:30:00Z" }], nextCursor: null, revision: 2 } : String(path).includes("/history") ? { items: [{ entryId: "bill", version: 2, actorId: "alice", origin: "app", operationId: "op", action: "correct", acceptedAt: "2026-11-19T01:00:00Z", snapshot: entry, transitions: [{ entryId: "bill", version: 2, memberId: "alice", currency: "INR", amountMinor: -40000, effectKind: "reversal" }, { entryId: "bill", version: 2, memberId: "alice", currency: "INR", amountMinor: 45000, effectKind: "replacement" }] }], nextCursor: null, revision: 2 } : { entry, revision: 2, refundCapacity: capacity }; return new Response(JSON.stringify({ data, error: null }), { status: 200 }); }); vi.stubGlobal("fetch", mock); return mock; }
it("explains immutable comments and correction reversal/replacement with historical names", async () => { setup(); const back = vi.fn(); render(<EntryDetail user={user} members={members} entryId="bill" onBack={back} onAccepted={vi.fn()}/>); expect(await screen.findByText("Dinner notes")).toBeInTheDocument(); expect(await screen.findByText("Shared with everyone")).toBeInTheDocument(); expect(await screen.findByText("Reversal · Alice · -₹400.00")).toBeInTheDocument(); expect(screen.getByText("Replacement · Alice · ₹450.00")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Back to previous money view" })); expect(back).toHaveBeenCalledOnce(); });
it("appends an attributed comment through retained command acceptance and clears its owned slot", async () => { const accepted = vi.fn(); const mock = setup(async (_path, init) => new Response(JSON.stringify({ data: { status: "accepted", comment: { id: "new", entryId: "bill", observedVersion: 2, authorId: "alice", text: JSON.parse(String(init.body)).text, acceptedAt: "2026-11-19T02:00:00Z" } }, error: null }), { status: 201 })); render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={accepted}/>); fireEvent.click(await screen.findByRole("button", { name: "Add comment" })); await screen.findByLabelText("Comment"); fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Thanks" } }); fireEvent.click(screen.getByRole("button", { name: "Append comment" })); await waitFor(() => expect(accepted).toHaveBeenCalledOnce()); const call = mock.mock.calls.find(([, init]) => init?.method === "POST")!; expect(call[0]).toContain("/entries/bill/comments"); expect(call[1]?.headers).toMatchObject({ "If-Match": "2", "X-Operation-ID": expect.any(String) }); expect(await homeOSDatabase.householdCache.filter(row => row.key.includes("ledger:attempt")).count()).toBe(0); });
it("retains entered linked refund allocations after stale capacity refusal and permits deliberate capacity refresh", async () => { const mock = setup(async () => new Response(JSON.stringify({ data: null, error: { code: "validation_error", message: "Refund capacity changed" } }), { status: 400 })); render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={vi.fn()}/>); fireEvent.click(await screen.findByRole("button", { name: "Record refund" })); await screen.findByLabelText("Refund amount"); fireEvent.change(screen.getByLabelText("Refund amount"), { target: { value: "100" } }); for (const [label, value] of [["Returned to original payers: Alice", "100"], ["Credited beneficiaries: Alice", "50"], ["Credited beneficiaries: Bob", "50"]])
    fireEvent.change(screen.getByLabelText(label), { target: { value } }); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Record refund" })); expect(await screen.findByRole("alert")).toHaveTextContent("Refund capacity changed"); expect(screen.getByLabelText("Refund amount")).toHaveValue("100"); fireEvent.click(screen.getByRole("button", { name: "Refresh original and capacity · keep input" })); await waitFor(() => expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill")).length).toBeGreaterThan(2)); expect(screen.getByLabelText("Credited beneficiaries: Bob")).toHaveValue("50"); });
it("keeps refund input in its opened currency and blocks saving when capacity refresh changes original currency", async () => {
    const { RefundDialog } = await import("./refund-dialog");
    const accepted = vi.fn();
    const { rerender } = render(<RefundDialog user={user} members={members} original={entry} capacity={capacity} onClose={vi.fn()} onAccepted={accepted}/>);
    await screen.findByLabelText("Refund amount");
    fireEvent.change(screen.getByLabelText("Refund amount"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Returned to original payers: Alice"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Credited beneficiaries: Alice"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Credited beneficiaries: Bob"), { target: { value: "50" } });
    expect(screen.getByRole("button", { name: "Record refund" })).toBeEnabled();
    const changed = { ...entry, version: 3, intent: { ...entry.intent, currency: "JPY" as const } };
    rerender(<RefundDialog user={user} members={members} original={changed} capacity={{ ...capacity, totalMinor: 900, remainingMinor: 900 }} onClose={vi.fn()} onAccepted={accepted}/>);
    expect(screen.getByLabelText("Refund amount")).toHaveValue("100");
    expect(screen.getByLabelText("Refund effect")).toHaveTextContent("₹100.00");
    expect(screen.getByRole("button", { name: "Record refund" })).toBeDisabled();
    expect(screen.getByText(/The original currency changed/)).toBeInTheDocument();
    expect(accepted).not.toHaveBeenCalled();
});
it("cancels an unopened lifecycle confirmation without a discard warning", async () => { setup(); render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={vi.fn()}/>); fireEvent.click(await screen.findByRole("button", { name: "Void entry" })); await screen.findByRole("button", { name: "Confirm void" }); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" })); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(screen.queryByText("Discard unsaved draft?")).not.toBeInTheDocument(); });

it.each([
    { open: "Void entry", submit: "Confirm void", lifecycle: "effective" as const },
    { open: "Restore entry", submit: "Confirm restore", lifecycle: "void" as const },
    { open: "Add comment", submit: "Append comment", lifecycle: "effective" as const },
])("keeps the opened version for $open across same-person detail refresh", async ({ open, submit, lifecycle }) => {
    let current: LedgerEntry = { ...entry, lifecycle };
    const mock = setup(async () => new Response(JSON.stringify({ data: null, error: { code: "invalid_request", message: "Review the opened version" } }), { status: 400 }));
    const originalFetch = mock.getMockImplementation()!;
    mock.mockImplementation(async (path, init) => !init?.method && String(path).endsWith("/entries/bill")
        ? new Response(JSON.stringify({ data: { entry: current, revision: current.version, refundCapacity: capacity }, error: null }), { status: 200 })
        : originalFetch(path, init));
    const props = { user, members, entryId: "bill", onBack: vi.fn(), onAccepted: vi.fn() };
    const view = render(<EntryDetail {...props}/>);
    fireEvent.click(await screen.findByRole("button", { name: open }));
    await screen.findByRole("button", { name: submit });
    if (open === "Add comment") fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep the version I reviewed" } });
    current = { ...current, version: 3 };
    view.rerender(<EntryDetail {...props} user={{ ...user }}/>);
    await screen.findByText(new RegExp(`Version 3`));
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(mock.mock.calls.find(([, init]) => init?.method === "POST")![1]?.headers).toMatchObject({ "If-Match": "2" });
});
