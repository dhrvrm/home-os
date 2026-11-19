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
it("retains entered linked refund allocations after stale capacity refusal and permits deliberate capacity refresh", async () => { const mock = setup(async () => new Response(JSON.stringify({ data: null, error: { code: "validation_error", message: "Refund capacity changed" } }), { status: 400 }));
    const original = mock.getMockImplementation()!;
    let refreshed = false;
    mock.mockImplementation(async (path, init) => !init?.method && String(path).endsWith("/entries/bill") && refreshed
        ? new Response(JSON.stringify({ data: { entry, revision: 3, refundCapacity: { ...capacity, creditedMinor: 10000, remainingMinor: 80000, payers: capacity.payers.map(p => ({ ...p, creditedMinor: 10000, remainingMinor: 80000 })), shares: capacity.shares.map(p => ({ ...p, creditedMinor: 5000, remainingMinor: 40000 })) } }, error: null }))
        : original(path, init));
    render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={vi.fn()}/>); fireEvent.click(await screen.findByRole("button", { name: "Record refund" })); await screen.findByLabelText("Refund amount"); fireEvent.change(screen.getByLabelText("Refund amount"), { target: { value: "100" } }); for (const [label, value] of [["Returned to original payers: Alice", "100"], ["Credited beneficiaries: Alice", "50"], ["Credited beneficiaries: Bob", "50"]])
    fireEvent.change(screen.getByLabelText(label), { target: { value } }); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Record refund" })); expect(await screen.findByRole("alert")).toHaveTextContent("Refund capacity changed"); expect(screen.getByLabelText("Refund amount")).toHaveValue("100"); refreshed = true; fireEvent.click(screen.getByRole("button", { name: "Refresh original and capacity · keep input" })); await waitFor(() => expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill")).length).toBe(2)); expect(await screen.findByText(/Remaining refund capacity · ₹800.00/)).toBeInTheDocument(); expect(screen.getByLabelText("Credited beneficiaries: Bob")).toHaveValue("50"); });
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

it("discards a comment only after confirmed dismissal and reopens an empty comment editor", async () => {
    setup(); render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Add comment" }));
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Discard this explanation" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Comment")).toHaveValue("Discard this explanation");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByLabelText("Comment")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Append comment" })).toBeDisabled();
});
it.each(["expense", "payment"] as const)("reads %s detail once and never starts a linked original read", async kind => {
    const mock = setup();
    if (kind === "payment") {
        const original = mock.getMockImplementation()!;
        mock.mockImplementation(async (path, init) => String(path).endsWith("/entries/bill") ? new Response(JSON.stringify({ data: { entry: { ...entry, payers: [], shares: [], intent: { kind: "payment", date: "2026-11-19", currency: "INR", totalMinor: 90000, senderId: "alice", receiverId: "bob", method: "Cash" } }, revision: 2 }, error: null })) : original(path, init));
    }
    render(<EntryDetail user={user} members={members} entryId="bill" onBack={vi.fn()} onAccepted={vi.fn()}/>);
    await screen.findByRole("button", { name: "Correct entry" });
    expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill"))).toHaveLength(1);
});
it("loads the linked original only for refund correction and exposes its failure and retry", async () => {
    const refund: LedgerEntry = { ...entry, id: "refund", payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "bob", amountMinor: 5000 }], intent: { kind: "refund", expenseId: "bill", date: "2026-11-19", description: "Returned dinner", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "bob", amountMinor: 5000 }] } };
    let linkedFails = true;
    const mock = setup(); const original = mock.getMockImplementation()!;
    mock.mockImplementation(async (path, init) => String(path).endsWith("/entries/refund") ? new Response(JSON.stringify({ data: { entry: refund, revision: 2 }, error: null })) : String(path).endsWith("/entries/bill") && linkedFails ? new Response(JSON.stringify({ data: null, error: { code: "unavailable", message: "Original temporarily unavailable" } }), { status: 503 }) : original(path, init));
    render(<EntryDetail user={user} members={members} entryId="refund" onBack={vi.fn()} onAccepted={vi.fn()}/>);
    await screen.findByRole("heading", { name: "Returned dinner" });
    expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Correct entry" }));
    expect(await screen.findByText("Original temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Returned dinner" })).toBeInTheDocument();
    linkedFails = false;
    fireEvent.click(within(screen.getByRole("region", { name: "Original expense for refund" })).getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Refund amount")).toHaveValue("100.00");
    expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/refund"))).toHaveLength(1);
    expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill"))).toHaveLength(2);
});

it("keeps linked-original loading, errors and retry inside an opened refund modal without losing its draft", async () => {
    const refund: LedgerEntry = { ...entry, id: "refund", payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "bob", amountMinor: 5000 }], intent: { kind: "refund", expenseId: "bill", date: "2026-11-19", description: "Returned dinner", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "bob", amountMinor: 5000 }] } };
    const mock = setup(); const original = mock.getMockImplementation()!;
    let failRefresh = false;
    let completeRefresh: ((response: Response) => void) | undefined;
    mock.mockImplementation(async (path, init) => String(path).endsWith("/entries/refund") ? new Response(JSON.stringify({ data: { entry: refund, revision: 2 }, error: null })) : String(path).endsWith("/entries/bill") && failRefresh ? new Promise<Response>(resolve => { completeRefresh = resolve; }) : original(path, init));
    render(<EntryDetail user={user} members={members} entryId="refund" onBack={vi.fn()} onAccepted={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Correct entry" }));
    fireEvent.change(await screen.findByLabelText("Refund amount"), { target: { value: "110" } });
    failRefresh = true;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Refresh original and capacity · keep input" }));
    expect(await within(screen.getByRole("dialog")).findByText("Loading original expense…")).toBeInTheDocument();
    await waitFor(() => expect(completeRefresh).toBeDefined());
    completeRefresh!(new Response(JSON.stringify({ data: null, error: { code: "unavailable", message: "Original refresh failed" } }), { status: 503 }));
    expect(await within(screen.getByRole("dialog")).findByText("Original refresh failed")).toBeInTheDocument();
    expect(screen.getByLabelText("Refund amount")).toHaveValue("110");
    failRefresh = false;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText("Original refresh failed")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Refund amount")).toHaveValue("110");
    expect(screen.getByLabelText("Credited beneficiaries: Bob")).toHaveValue("50.00");
    await waitFor(() => expect(mock.mock.calls.filter(([path]) => String(path).endsWith("/entries/bill"))).toHaveLength(3));
    expect(mock.mock.calls.some(([, init]) => !!init?.method)).toBe(false);
});
