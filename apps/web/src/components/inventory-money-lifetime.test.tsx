import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { drainHouseholdWork, publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import type { AuthSession } from "@/lib/auth";
import { checkAttempt, readAttempt, submitAttempt } from "@/ledger/attempt-state";
import type { LedgerCommand, LedgerEntry } from "@/ledger/types";
import { homeOSDatabase } from "@/offline/db";
import { InventoryApp } from "./inventory-app";

const session: AuthSession = { sessionId: "a".repeat(32), user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "member" }, expiresAt: "2099-12-01T00:00:00.000Z" };
const reply = (data: unknown) => new Response(JSON.stringify({ data, error: null }));
function admit(current = session) {
  setActiveMemberId(current.user.id);
  publishAccessBoundary("ready", current.user);
  resumeHouseholdWork();
}
function fixture() {
  let release: (() => void) | undefined;
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const p = String(path);
    if (init?.method === "POST" && p.endsWith("/ledger/expenses")) {
      const intent = JSON.parse(String(init.body));
      return new Promise<Response>(resolve => {
        release = () => resolve(reply({ status: "accepted", entry: { id: "saved-bill", householdId: "home", version: 1, lifecycle: "effective", intent, payers: intent.payers, shares: [{ memberId: "alice", amountMinor: 10000 }], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" } }));
      });
    }
    if (p.includes("/entries/saved-bill")) return new Response(JSON.stringify({ data: null, error: { code: "unavailable", message: "Latest entry unavailable" } }), { status: 503 });
    return reply(p.includes("/members") ? { members: [{ id: "alice", name: "Alice", active: true }] } : p.includes("/ledger") ? { items: [], nextCursor: null, revision: 1, totals: [], groupBy: "month" } : { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, release: async () => { await waitFor(() => expect(release).toBeTypeOf("function")); await act(async () => { release!(); await drainHouseholdWork(); }); } };
}
function navigate(name: string) {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Primary navigation" })).getByRole("button", { name }));
}
async function draft() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Add expense" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
  await screen.findByLabelText("Description");
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this dinner" } });
}
async function save(includeBob = false) {
  await draft();
  fireEvent.change(screen.getByLabelText("Bill amount"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "100" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
  if (includeBob) fireEvent.click(screen.getByRole("checkbox", { name: "Bob" }));
  fireEvent.click(screen.getByRole("button", { name: "Save expense" }));
  await waitFor(async () => expect(await readAttempt(session.user)).not.toBeNull());
}
beforeEach(async () => {
  localStorage.clear();
  await homeOSDatabase.delete();
  await homeOSDatabase.open();
  admit();
  window.history.replaceState(null, "", "/?view=expenses");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

function refreshingFixture(recovery = false) {
  let accepted = false;
  let release: (() => void) | undefined;
  const expense = {
    id: "saved-bill", householdId: "home", version: 1, lifecycle: "effective",
    intent: { kind: "expense", date: "2026-11-19", description: "Dinner before correction", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }, { memberId: "bob", kind: "equal" }] } } },
    payers: [{ memberId: "alice", amountMinor: 10000 }], shares: [{ memberId: "alice", amountMinor: 5000 }, { memberId: "bob", amountMinor: 5000 }], createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z",
  } satisfies LedgerEntry;
  const command = { action: "correct", operationId: crypto.randomUUID(), entryId: expense.id, expectedVersion: 1, entry: { ...expense.intent, description: "Dinner after correction" } } satisfies LedgerCommand;
  let recorded: LedgerEntry = expense;
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const p = String(path);
    if (init?.method && init.method !== "GET") {
      if (recovery) throw new TypeError("Accepted response was lost");
      const intent = JSON.parse(String(init.body));
      recorded = { ...expense, intent };
      return new Promise<Response>(resolve => { release = () => { accepted = true; resolve(reply({ status: "accepted", entry: recorded })); }; });
    }
    if (p.includes("/operations/")) {
      accepted = true;
      if (recovery) recorded = { ...expense, version: 2, intent: command.entry };
      return reply({ status: "accepted", entryId: expense.id, version: recovery ? 2 : 1, action: recovery ? "correct" : "create" });
    }
    if (p.includes("/members")) return reply({ members: [{ id: "alice", name: "Alice", active: true }, { id: "bob", name: "Bob", active: true }] });
    const revision = accepted ? 2 : 1;
    if (p.endsWith("/entries/saved-bill")) {
      if (!recovery && !accepted) return new Response(JSON.stringify({ data: null, error: { code: "not_found", message: "Entry not recorded yet" } }), { status: 404 });
      return reply({ entry: recorded, revision });
    }
    if (p.includes("/entries/saved-bill/comments")) return reply({ items: accepted ? [{ id: "comment", entryId: expense.id, observedVersion: recorded.version, authorId: "alice", text: "Latest accepted explanation", acceptedAt: "2026-11-19T00:00:00Z" }] : [], nextCursor: null, revision });
    if (p.includes("/balances")) return reply({ items: [{ memberId: "alice", displayName: "Alice", active: true, currency: "INR", paidMinor: accepted ? 10000 : 0, shareMinor: accepted ? 5000 : 0, sentMinor: 0, receivedMinor: 0, netMinor: accepted ? 5000 : 0 }], nextCursor: null, revision, totals: [] });
    return reply(p.includes("/ledger") ? { items: [], nextCursor: null, revision, totals: [], groupBy: "month" } : { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { command, fetchMock, release: async () => { await waitFor(() => expect(release).toBeTypeOf("function")); await act(async () => { release!(); await drainHouseholdWork(); }); } };
}
function openEntryRoute() {
  window.history.pushState(null, "", "/?view=expenses&entryId=saved-bill");
  fireEvent(window, new PopStateEvent("popstate"));
}

it("refreshes the mounted balance and current entry when a departed held save is accepted", async () => {
  const api = refreshingFixture();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<InventoryApp session={session} />);
  await save(true);
  navigate("Inventory");
  openEntryRoute();
  expect(await screen.findByText(/Entry not recorded yet/)).toBeInTheDocument();
  expect(await screen.findByText("Settled")).toBeInTheDocument();
  const detail = screen.getByRole("region", { name: "Financial entry" });
  await api.release();
  expect(await readAttempt(session.user)).toBeNull();
  expect(await screen.findByText("You are owed ₹50.00")).toBeInTheDocument();
  expect(await within(detail).findByRole("heading", { name: "Keep this dinner" })).toBeInTheDocument();
  expect(await within(detail).findByText("Latest accepted explanation")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Financial entry" })).toBe(detail);
  expect(window.location.search).toBe("?view=expenses&entryId=saved-bill");
  expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("refreshes the same mounted entry after top-level retained-save recovery", async () => {
  const api = refreshingFixture(true);
  expect((await submitAttempt(session.user, api.command)).kind).toBe("unknown");
  window.history.replaceState(null, "", "/?view=expenses&entryId=saved-bill");
  render(<InventoryApp session={session} />);
  expect(await screen.findByRole("heading", { name: "Dinner before correction" })).toBeInTheDocument();
  expect(await screen.findByText("Settled")).toBeInTheDocument();
  const detail = screen.getByRole("region", { name: "Financial entry" });
  fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
  expect(await screen.findByText("You are owed ₹50.00")).toBeInTheDocument();
  expect(await within(detail).findByRole("heading", { name: "Dinner after correction" })).toBeInTheDocument();
  expect(await within(detail).findByText("Latest accepted explanation")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Financial entry" })).toBe(detail);
  expect(await readAttempt(session.user)).toBeNull();
  expect(window.location.search).toBe("?view=expenses&entryId=saved-bill");
  expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(1);
});

it("refreshes accepted reads without replacing a newer dirty draft or releasing its guard", async () => {
  const api = refreshingFixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<InventoryApp session={session} />);
  await save(true);
  navigate("Inventory");
  navigate("Expenses");
  expect(await screen.findByText("Settled")).toBeInTheDocument();
  // A second recovery can resolve the old slot while its first response is held.
  expect((await checkAttempt(session.user)).kind).toBe("accepted");
  expect(await readAttempt(session.user)).toBeNull();
  await draft();
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New draft after recovery" } });
  const editor = screen.getByRole("dialog", { name: "Add expense" });
  confirm.mockClear().mockReturnValue(false);
  await api.release();
  expect(await screen.findByText("You are owed ₹50.00")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Add expense" })).toBe(editor);
  expect(screen.getByLabelText("Description")).toHaveValue("New draft after recovery");
  expect(await readAttempt(session.user)).toBeNull();
  navigate("Inventory");
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Description")).toHaveValue("New draft after recovery");
  expect(window.location.search).toBe("?view=expenses");
  expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("refreshes old acceptance without changing a newer retained save or its recovery guard", async () => {
  const api = refreshingFixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<InventoryApp session={session} />);
  await save(true);
  navigate("Inventory");
  navigate("Expenses");
  expect(await screen.findByText("Settled")).toBeInTheDocument();
  expect((await checkAttempt(session.user)).kind).toBe("accepted");
  const originalFetch = api.fetchMock.getMockImplementation()!;
  api.fetchMock.mockImplementation(async (path, init) => {
    if (init?.method === "POST" && String(path).endsWith("/comments")) throw new TypeError("Newer comment response lost");
    return originalFetch(path, init);
  });
  const newer: LedgerCommand = { action: "comment", operationId: crypto.randomUUID(), entryId: "saved-bill", expectedVersion: 1, text: "Keep the newer original intent" };
  expect((await submitAttempt(session.user, newer)).kind).toBe("unknown");
  const retained = await readAttempt(session.user);
  expect(retained?.command).toEqual(newer);
  fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
  const editor = await screen.findByRole("dialog", { name: "Add expense" });
  expect(await within(editor).findByText("Original action · comment")).toBeInTheDocument();
  const writes = () => api.fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET").length;
  expect(writes()).toBe(2);
  confirm.mockClear().mockReturnValue(false);
  await api.release();
  expect(await screen.findByText("You are owed ₹50.00")).toBeInTheDocument();
  expect(await readAttempt(session.user)).toEqual(retained);
  expect(screen.getByRole("dialog", { name: "Add expense" })).toBe(editor);
  expect(within(editor).getByText("Original action · comment")).toBeInTheDocument();
  navigate("Inventory");
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Add expense" })).toBe(editor);
  expect(window.location.search).toBe("?view=expenses");
  expect(writes()).toBe(2);
});

it("opens a voided recurring original after a period conflict without a redundant discard confirmation", async () => {
  const rule = { id: "rent", householdId: "home", name: "Rent", amountMinor: 10000, currency: "INR", cadence: { unit: "month", interval: 1, anchorDate: "2026-01-31" }, participants: [{ memberId: "alice", override: null, shareMinor: 10000, memberActive: true }], needsAttention: false, version: 3, archivedAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const source = { ruleId: "rent", ruleVersion: 3, period: 1, periodStart: "2026-02-28", periodEnd: "2026-03-31", snapshot: { name: "Rent", currency: "INR", totalMinor: 10000, cadence: rule.cadence, shares: [{ memberId: "alice", amountMinor: 10000 }] } };
  const intent = { kind: "expense", description: "Rent original", date: "2026-02-28", currency: "INR", totalMinor: 10000, payers: [{ memberId: "alice", amountMinor: 10000 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "alice", kind: "equal" }] } } };
  const original = { id: "original", householdId: "home", version: 2, lifecycle: "void", intent, payers: intent.payers, shares: [{ memberId: "alice", amountMinor: 10000 }], source, createdAt: "2026-02-28T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  const fetchMock = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const p = String(path);
    if (p.includes("/rule-postings") && init?.method === "POST") return new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Period already posted", details: original } }), { status: 409 });
    if (p.includes("/preview")) {
      const period = JSON.parse(String(init?.body)).period;
      return reply({ source: period === 1 ? source : { ...source, period: 0, periodStart: "2026-01-31", periodEnd: "2026-02-28" } });
    }
    if (p.endsWith("/entries/original")) return reply({ entry: original, revision: 8 });
    if (p.includes("/members")) return reply({ members: [{ id: "alice", name: "Alice", active: true }] });
    if (p.includes("/expenses")) return reply({ rules: p.includes("archived") ? [] : [rule] });
    return reply(p.includes("/ledger") ? { items: [], nextCursor: null, revision: 8, totals: [], groupBy: "month" } : { items: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  window.history.replaceState(null, "", "/?view=expenses&ledgerTab=rules");
  render(<InventoryApp session={session} />);
  fireEvent.click(await screen.findByRole("button", { name: "Record period for Rent" }));
  await screen.findByLabelText("Billing period number");
  fireEvent.change(screen.getByLabelText("Billing period number"), { target: { value: "1" } });
  await screen.findByText(/Normalized period · 2026-02-28 to 2026-03-31/);
  fireEvent.click(screen.getByRole("button", { name: "Record period expense" }));
  expect(await screen.findByText("Period already posted")).toBeInTheDocument();
  expect(await readAttempt(session.user)).toBeNull();
  const postCount = () => fetchMock.mock.calls.filter(([path, init]) => String(path).includes("/rule-postings") && init?.method === "POST").length;
  expect(postCount()).toBe(1);
  navigate("Inventory");
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Post recurring period" })).toBeInTheDocument();
  confirm.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Open existing original" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "Rent original" })).toBeInTheDocument();
  expect(screen.getByText(/Voided · no current balance effect/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restore entry" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Post recurring period" })).not.toBeInTheDocument();
  expect(window.location.search).toContain("entryId=original");
  expect(await readAttempt(session.user)).toBeNull();
  expect(postCount()).toBe(1);
});
afterEach(async () => {
  cleanup();
  await drainHouseholdWork();
  await homeOSDatabase.delete();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("retains a held save's recorded reference after leaving the editor without forcing a return", async () => {
  const api = fixture();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<InventoryApp session={session} />);
  await save();
  navigate("Inventory");
  expect(screen.queryByRole("dialog", { name: "Add expense" })).not.toBeInTheDocument();
  expect(window.location.search).toBe("?view=inventory");
  await api.release();
  expect(await readAttempt(session.user)).toBeNull();
  expect(window.location.search).toBe("?view=inventory");
  navigate("Expenses");
  expect(await screen.findByText(/Recorded\. This accepted save is complete\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open recorded entry" }));
  await waitFor(() => expect(window.location.search).toContain("entryId=saved-bill"));
  expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it.each(["sidebar", "popstate"])("keeps the dirty guard when %s targets the current financial destination", async kind => {
  fixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<InventoryApp session={session} />);
  await draft();
  if (kind === "sidebar") navigate("Expenses");
  else fireEvent(window, new PopStateEvent("popstate"));
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Description")).toHaveValue("Keep this dinner");
  navigate("Inventory");
  expect(confirm).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Description")).toHaveValue("Keep this dinner");
  expect(window.location.search).toBe("?view=expenses");
});

it.each(["role", "person"])("does not publish a held old save after the app's %s changes", async change => {
  const api = fixture();
  const { rerender } = render(<InventoryApp session={session} />);
  await save();
  const next: AuthSession = { ...session, user: change === "role" ? { ...session.user, role: "viewer" } : { ...session.user, id: "bob", name: "Bob" } };
  admit(next);
  rerender(<InventoryApp session={next} />);
  await api.release();
  expect(screen.queryByText(/Recorded\. This accepted save is complete\./)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open recorded entry" })).not.toBeInTheDocument();
  expect(window.location.search).toBe("?view=expenses");
  expect(api.fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
