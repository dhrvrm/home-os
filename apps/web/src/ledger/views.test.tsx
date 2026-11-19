import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import { LedgerView } from "./ledger-view";
import { PaymentDialog } from "./payment-dialog";
import { MoneyLifetimeProvider, useMoneyGuard } from "./money-lifetime";
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
it.each([{ home: "home", sourceRule: "rent", allowed: true }, { home: "another-home", sourceRule: "rent", allowed: false }, { home: "home", sourceRule: "another-rule", allowed: false }, { home: "home", sourceRule: "rent", allowed: true, otherEditor: true }])("uses the server period and checks duplicate original ownership/source ($home/$sourceRule; other editor: $otherEditor)", async ({ home, sourceRule, allowed, otherEditor }) => {
    const rule = { id: "rent", householdId: "home", name: "Rent", amountMinor: 10000, currency: "INR", cadence: { unit: "month", interval: 1, anchorDate: "2026-01-31" }, participants: [{ memberId: "alice", override: null, shareMinor: 10000, memberActive: true }], needsAttention: false, version: 3, archivedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
    const source = { ruleId: "rent", ruleVersion: 3, period: 0, periodStart: "2026-01-31", periodEnd: "2026-02-28", snapshot: { name: "Rent", currency: "INR", totalMinor: 10000, cadence: rule.cadence, shares: [{ memberId: "alice", amountMinor: 10000 }] } };
    const intent = { kind: "expense", description: "Rent original", date: "2026-01-31", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }] } } };
    const original = { id: "original", householdId: home, version: 2, lifecycle: "void", intent, payers: intent.payers, shares: [{ memberId: "alice", amountMinor: 10000 }], source: { ...source, ruleId: sourceRule }, createdAt: "2026-01-31T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
    let guarded = false; const observedGuard = vi.fn();
    function OtherEditor() { useMoneyGuard(true); return null; }
    const navigate = vi.fn(() => { observedGuard(guarded); });
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL) => { const p = String(path); const data = p.includes("/members") ? { members } : p.includes("/expenses") ? { rules: p.includes("archived") ? [] : [rule] } : p.includes("/preview") ? { source } : { items: [balance], nextCursor: null, revision: 8, totals: [] }; if (p.includes("/rule-postings"))
        return new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Period already posted", details: original } }), { status: 409 }); return new Response(JSON.stringify({ data, error: null }), { status: 200 }); }));
    render(<MoneyLifetimeProvider user={user} onRecorded={vi.fn()} onGuardChange={value => { guarded = value; }}><LedgerView user={user} location={{ view: "expenses", ledgerTab: "rules" }} onNavigate={navigate}/>{otherEditor && <OtherEditor />}</MoneyLifetimeProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Record period for Rent" }));
    await screen.findByText(/Normalized period · 2026-01-31 to 2026-02-28/);
    fireEvent.change(screen.getByLabelText("Actual expense date"), { target: { value: "2026-02-01" } });
    await waitFor(() => expect(guarded).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Record period expense" }));
    await screen.findByText("Period already posted");
    if (allowed) {
        fireEvent.click(await screen.findByRole("button", { name: "Open existing original" }));
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ entryId: "original", ledgerTab: "rules" }));
        expect(observedGuard).toHaveBeenCalledExactlyOnceWith(!!otherEditor);
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
it.each([
    { open: "Void entry", submit: "Confirm void", initial: "effective", final: "void", net: 0, fails: false, recovery: false },
    { open: "Void entry", submit: "Confirm void", initial: "effective", final: "void", net: 0, fails: false, recovery: true },
    { open: "Restore entry", submit: "Confirm restore", initial: "void", final: "effective", net: 60000, fails: false },
    { open: "Void entry", submit: "Confirm void", initial: "effective", final: "void", net: 0, fails: true },
    { open: "Void entry", submit: "Confirm void", initial: "effective", final: "void", net: 0, fails: false, provider: true },
])("refreshes the personal balance after same-URL $open acceptance (refresh fails: $fails; provider: $provider)", async ({ open, submit, initial, final, net, fails, recovery, provider }) => {
    const intent = { kind: "expense", description: "Dinner", date: "2026-11-19", currency: "INR", totalMinor: 90000, payers: [{ memberId: "alice", amountMinor: 90000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }, { memberId: "bob", kind: "equal" }, { memberId: "departed", kind: "equal" }] } } };
    const initialEntry = { id: "bill", householdId: "home", version: 2, lifecycle: initial, intent, payers: intent.payers, shares: members.map(m => ({ memberId: m.id, amountMinor: 30000 })), createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" };
    let saved = false;
    let balanceReads = 0; let detailReads = 0;
    const navigate = vi.fn(); const recorded = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
        const p = String(path);
        if (p.endsWith("/entries/bill")) detailReads++;
        const current = saved ? { ...initialEntry, lifecycle: final, version: 3 } : initialEntry;
        if (init?.method === "POST") { saved = true; if (recovery) throw new TypeError("Response lost after acceptance"); return new Response(JSON.stringify({ data: { status: "accepted", entry: { ...initialEntry, lifecycle: final, version: 3 } }, error: null }), { status: 201 }); }
        if (p.includes("/operations/")) return new Response(JSON.stringify({ data: { status: "accepted", entryId: "bill", version: 3, action: initial === "void" ? "restore" : "void" }, error: null }));
        if (p.includes("/balances")) {
            balanceReads++;
            if (saved && fails) return new Response(JSON.stringify({ data: null, error: { code: "unavailable", message: "Balance refresh unavailable" } }), { status: 503 });
        }
        const data = p.includes("/members") ? { members } : p.includes("/balances") ? { items: [{ ...balance, netMinor: saved ? net : initial === "void" ? 0 : 60000 }], nextCursor: null, revision: saved ? 9 : 8, totals: [] } : p.endsWith("/entries/bill") ? { entry: current, revision: saved ? 9 : 8 } : { items: [], nextCursor: null, revision: 8 };
        return new Response(JSON.stringify({ data, error: null }));
    }));
    const ledger = <LedgerView user={user} location={{ view: "expenses", entryId: "bill" }} onNavigate={navigate} onRecorded={provider ? undefined : recorded}/>;
    render(provider ? <MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}>{ledger}</MoneyLifetimeProvider> : ledger);
    await screen.findByText(initial === "void" ? "Settled" : "You are owed ₹600.00");
    fireEvent.click(await screen.findByRole("button", { name: open }));
    fireEvent.click(await screen.findByRole("button", { name: submit }));
    if (recovery) {
        await screen.findByRole("heading", { name: "Save outcome unknown" });
        fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    }
    await waitFor(() => expect(recorded).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ entryId: "bill" }));
    await screen.findByText(new RegExp("Version 3"));
    await waitFor(() => expect(balanceReads).toBe(2));
    if (provider) expect(detailReads).toBe(2);
    expect(screen.getByText("Recorded. This accepted save is complete.")).toBeInTheDocument();
    if (fails) expect(await screen.findByText("Balance refresh unavailable")).toBeInTheDocument();
    else expect(await screen.findByText(net === 0 ? "Settled" : "You are owed ₹600.00")).toBeInTheDocument();
});
it("keeps the accepted corrected payment and personal header in agreement on the same URL", async () => {
    const intent = { kind: "payment", date: "2026-11-19", currency: "INR", totalMinor: 10000, senderId: "bob", receiverId: "alice", method: "Cash" };
    const original = { id: "payment", householdId: "home", version: 2, lifecycle: "effective", intent, payers: [], shares: [], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" };
    let corrected = false;
    const recorded = vi.fn(); const navigate = vi.fn();
    const mock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
        const p = String(path);
        if (init?.method === "PUT") {
            corrected = true;
            return new Response(JSON.stringify({ data: { status: "accepted", entry: { ...original, version: 3, intent: JSON.parse(String(init.body)) } }, error: null }));
        }
        const data = p.includes("/members") ? { members } : p.includes("/balances") ? { items: [{ ...balance, receivedMinor: corrected ? 20000 : 10000, netMinor: corrected ? 40000 : 50000 }], nextCursor: null, revision: corrected ? 9 : 8, totals: [] } : p.endsWith("/entries/payment") ? { entry: corrected ? { ...original, version: 3, intent: { ...intent, totalMinor: 20000 } } : original, revision: corrected ? 9 : 8 } : { items: [], nextCursor: null, revision: 8 };
        return new Response(JSON.stringify({ data, error: null }));
    });
    vi.stubGlobal("fetch", mock);
    render(<LedgerView user={user} location={{ view: "expenses", entryId: "payment" }} onNavigate={navigate} onRecorded={recorded}/>);
    await screen.findByText("You are owed ₹500.00");
    fireEvent.click(await screen.findByRole("button", { name: "Correct entry" }));
    fireEvent.change(await screen.findByLabelText("Reported amount"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText("You are owed ₹400.00")).toBeInTheDocument();
    expect(await screen.findByText(/Version 3/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Financial entry" })).toHaveTextContent("₹200.00");
    expect(recorded).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ entryId: "payment" }));
    expect(mock.mock.calls.find(([, init]) => init?.method === "PUT")?.[1]?.headers).toMatchObject({ "If-Match": "2" });
});
