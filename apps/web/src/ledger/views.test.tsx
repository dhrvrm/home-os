import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import { LedgerView } from "./ledger-view";
import { PaymentDialog } from "./payment-dialog";
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "alice@example.com" };
const members = [{ id: "alice", name: "Alice", active: true }, { id: "bob", name: "Bob", active: true }, { id: "departed", name: "Former member", active: false }];
const balance = { memberId: "alice", displayName: "Alice", active: true, currency: "INR", paidMinor: 90000, shareMinor: 30000, sentMinor: 0, receivedMinor: 0, netMinor: 60000 };
beforeEach(async () => { setActiveMemberId(user.id); publishAccessBoundary("ready", user); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); });
afterEach(async () => { cleanup(); await homeOSDatabase.householdCache.clear(); vi.unstubAllGlobals(); });
function reads() { vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { const path = String(input); const data = path.includes("/members") ? { members } : path.includes("/balances") ? { items: [balance], nextCursor: null, revision: 8, totals: [] } : path.includes("/summaries") ? { items: [], nextCursor: null, revision: 8, totals: [], groupBy: "month" } : { items: [], nextCursor: null, revision: 8, totals: [] }; return new Response(JSON.stringify({ data, error: null }), { status: 200 }); })); }
it("opens actual expenses with complete personal balance, actual-record empty state and distinct tabs", async () => { reads(); render(<LedgerView user={user} location={{ view: "expenses" }} onNavigate={vi.fn()}/>); expect(await screen.findByText("You are owed ₹600.00")).toBeInTheDocument(); expect(await screen.findByText("No expenses recorded yet")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Recurring rules" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Add expense" })).toBeInTheDocument(); });
it("offers viewers reads and no mutation controls", async () => { reads(); const viewer = { ...user, role: "viewer" as const }; publishAccessBoundary("ready", viewer); render(<LedgerView user={viewer} location={{ view: "expenses" }} onNavigate={vi.fn()}/>); expect(await screen.findByText("You are owed ₹600.00")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Add expense" })).not.toBeInTheDocument(); expect(screen.getByText(/Viewers can inspect shared finances/)).toBeInTheDocument(); });
it("records an edited partial suggestion through durable unknown recovery, preserving departed parties", async () => { vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("lost response"))); render(<PaymentDialog user={user} members={members} suggestion={{ senderId: "bob", receiverId: "alice", currency: "INR", amountMinor: 60000 }} onAccepted={vi.fn()} onClose={vi.fn()}/>); await screen.findByLabelText("Reported amount"); expect(screen.getAllByRole("option", { name: "Former member · departed" })).toHaveLength(2); fireEvent.change(screen.getByLabelText("Reported amount"), { target: { value: "100" } }); fireEvent.change(screen.getByLabelText("Method"), { target: { value: "Cash" } }); expect(screen.getByLabelText("Payment effect")).toHaveTextContent("₹100.00"); fireEvent.click(screen.getByRole("button", { name: "Record payment" })); expect(await screen.findByRole("heading", { name: "Save outcome unknown" })).toBeInTheDocument(); const rows = await homeOSDatabase.householdCache.toArray(); expect(rows.some(row => JSON.stringify(row.data).includes('"totalMinor":10000'))).toBe(true); fireEvent(window, new Event("online")); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); });
it("shows persistent recovery after closing an unknown expense editor", async () => {
    reads();
    const readFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => args[1]?.method === "POST" ? Promise.reject(new TypeError("lost")) : readFetch(...args));
    render(<LedgerView user={user} location={{ view: "expenses" }} onNavigate={vi.fn()}/>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add expense" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    await screen.findByLabelText("Description");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Dinner" } });
    fireEvent.change(screen.getByLabelText("Bill amount"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
    fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
    await screen.findByRole("heading", { name: "Save outcome unknown" });
    fireEvent.click(screen.getByRole("button", { name: "Close recovery · keep retained save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Save outcome unknown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay same save" })).toBeInTheDocument();
});
it.each([{ home: "home", sourceRule: "rent", allowed: true }, { home: "another-home", sourceRule: "rent", allowed: false }, { home: "home", sourceRule: "another-rule", allowed: false }])("uses the server period and checks duplicate original ownership/source ($home/$sourceRule)", async ({ home, sourceRule, allowed }) => {
    const rule = { id: "rent", householdId: "home", name: "Rent", amountMinor: 10000, currency: "INR", cadence: { unit: "month", interval: 1, anchorDate: "2026-01-31" }, participants: [{ memberId: "alice", override: null, shareMinor: 10000, memberActive: true }], needsAttention: false, version: 3, archivedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const source = { ruleId: "rent", ruleVersion: 3, period: 0, periodStart: "2026-01-31", periodEnd: "2026-02-28", snapshot: { name: "Rent", currency: "INR", totalMinor: 10000, cadence: rule.cadence, shares: [{ memberId: "alice", amountMinor: 10000 }] } };
    const intent = { kind: "expense", description: "Rent original", date: "2026-01-31", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }] } } };
    const original = { id: "original", householdId: home, version: 2, lifecycle: "void", intent, payers: intent.payers, shares: [{ memberId: "alice", amountMinor: 10000 }], source: { ...source, ruleId: sourceRule }, createdAt: "2026-01-31T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => { const p = String(path); const data = p.includes("/members") ? { members } : p.includes("/expenses") ? { rules: p.includes("archived") ? [] : [rule] } : p.includes("/preview") ? { source } : { items: [balance], nextCursor: null, revision: 8, totals: [] }; if (p.includes("/rule-postings"))
        return new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Period already posted", details: original } }), { status: 409 }); return new Response(JSON.stringify({ data, error: null }), { status: 200 }); }));
    render(<LedgerView user={user} location={{ view: "expenses", ledgerTab: "rules" }} onNavigate={navigate}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Record period for Rent" }));
    await screen.findByText(/Normalized period · 2026-01-31 to 2026-02-28/);
    fireEvent.click(screen.getByRole("button", { name: "Record period expense" }));
    await screen.findByText("Period already posted");
    if (allowed) {
        fireEvent.click(await screen.findByRole("button", { name: "Open existing original" }));
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ entryId: "original", ledgerTab: "rules" }));
    }
    else {
        expect(screen.queryByRole("button", { name: "Open existing original" })).not.toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
    }
});
it("shows complete summary totals separately from paged groups and keeps category typing local until Apply", async () => {
    const navigate = vi.fn();
    let summaryPages = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => {
        const p = String(path);
        let data: unknown = p.includes("/members") ? { members } : p.includes("/balances") ? { items: [balance], nextCursor: null, revision: 8, totals: [] } : { items: [], nextCursor: null, revision: 8, totals: [] };
        if (p.includes("/summaries")) {
            summaryPages++;
            data = { items: [{ currency: "INR", group: p.includes("cursor=") ? "2026-02" : "2026-01", expenseMinor: 10000, creditMinor: 0, paymentMinor: 0, netSpendingMinor: 10000, count: 1 }], nextCursor: p.includes("cursor=") ? null : "next", revision: 8, groupBy: "month", totals: [{ currency: "INR", expenseMinor: 300000, creditMinor: 30000, paymentMinor: 0, netSpendingMinor: 270000, count: 30 }] };
        }
        return new Response(JSON.stringify({ data, error: null }), { status: 200 });
    }));
    render(<LedgerView user={user} location={{ view: "expenses", ledgerMemberId: "bob", category: "Food" }} onNavigate={navigate}/>);
    const totals = await screen.findByRole("region", { name: "Complete spending totals" });
    expect(totals).toHaveTextContent("₹3,000.00");
    expect(totals).toHaveTextContent("₹300.00");
    expect(totals).toHaveTextContent("₹2,700.00");
    expect(await screen.findByText("No records match these filters.")).toBeInTheDocument();
    expect(screen.getByText(/Spending scope ·/)).toHaveTextContent('Bob · category “Food”');
    const input = screen.getByLabelText("Category");
    input.focus();
    fireEvent.change(input, { target: { value: "Utilities" } });
    expect(input).toHaveFocus();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ category: "Utilities", ledgerMemberId: "bob" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("2026-02");
    expect(summaryPages).toBe(2);
    expect(screen.getByRole("region", { name: "Complete spending totals" })).toHaveTextContent("₹2,700.00");
});
it("defaults a manual payment to its selected ledger currency", async () => { render(<PaymentDialog user={user} members={members} defaultCurrency="USD" onClose={vi.fn()} onAccepted={vi.fn()}/>); expect(await screen.findByLabelText("Currency")).toHaveValue("USD"); });

it("keeps an identity-bound saved balance readable offline with explicit cached status",async()=>{
 reads();const first=render(<LedgerView user={user} location={{view:"expenses"}} onNavigate={vi.fn()}/>);await screen.findByText("You are owed ₹600.00");await screen.findByText("No expenses recorded yet");first.unmount();vi.spyOn(navigator,"onLine","get").mockReturnValue(false);render(<LedgerView user={user} location={{view:"expenses"}} onNavigate={vi.fn()}/>);expect(await screen.findByText("You are owed ₹600.00")).toBeInTheDocument();expect((await screen.findAllByText(/Saved copy ·/)).length).toBeGreaterThan(0);expect(screen.getByText(/Offline · saved financial copies are read-only/)).toBeInTheDocument();
});

it("offers a first-page restart for a stale financial cursor while preserving search scope",async()=>{
 reads();const original=vi.mocked(fetch).getMockImplementation()!;vi.mocked(fetch).mockImplementation(async(...args)=>String(args[0]).includes("/entries?")?new Response(JSON.stringify({data:null,error:{code:"ledger_revision_changed",message:"The ledger changed. Restart this query to use one financial basis."}}),{status:409}):original(...args));const navigate=vi.fn();render(<LedgerView user={user} location={{view:"expenses",ledgerCursor:"stale",search:"Dinner",category:"Food"}} onNavigate={navigate}/>);expect(await screen.findByText(/The ledger changed/)).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"Restart from first page"}));expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ledgerCursor:undefined,search:"Dinner",category:"Food"}));
});
