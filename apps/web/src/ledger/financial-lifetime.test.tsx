import { act, cleanup, render, renderHook, waitFor, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccessChangedError, publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import { homeOSDatabase } from "@/offline/db";
import type { AuthUser } from "@/lib/auth";
import * as attempts from "./attempt-state";
import { EntryDialog, useFinancialAttempt } from "./entry-dialog";
import { MoneyLifetimeProvider, useMoneyGuard, useMoneyLifetime, useMoneyReadSignal } from "./money-lifetime";
import { FinancialDialog } from "./payment-dialog";
import { useLedgerRead } from "./balances-view";
import type { LedgerCommand } from "./types";
const user: AuthUser = { id: "alice", householdId: "home", role: "member", name: "Alice", email: "a@example.com" };
beforeEach(async () => { localStorage.clear(); setActiveMemberId(user.id); publishAccessBoundary("ready", user); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); vi.stubGlobal("fetch", vi.fn()); });
afterEach(async () => { cleanup(); await homeOSDatabase.householdCache.clear(); vi.unstubAllGlobals(); });
it("settles its pending invocation even when the mounted task wrapper suppresses AccessChangedError", async () => {
  vi.spyOn(attempts, "checkAttempt").mockRejectedValueOnce(new AccessChangedError());
  const { result } = renderHook(() => useFinancialAttempt(user, vi.fn()));
  await act(async () => { await result.current.check(); });
  expect(result.current.pending).toBe(false);
});

const intent = (operationId = crypto.randomUUID()): LedgerCommand => ({ action: "comment", operationId, entryId: "entry", expectedVersion: 1, text: "Dinner" });
const reference = { status: "accepted" as const, entryId: "entry", version: 1, action: "comment", commentId: "comment" };
const accepted = { status: "accepted", comment: { id: "comment", entryId: "entry", observedVersion: 1, authorId: "alice", text: "Dinner", acceptedAt: "2026-11-19T00:00:00Z" } };
const reply = (data: unknown) => new Response(JSON.stringify({ data, error: null }));
it("publishes acceptance to the surviving app owner after the editor unmounts without calling its navigation callback", async () => {
  const recorded = vi.fn(); const acceptedEditor = vi.fn();
  let current!: ReturnType<typeof useFinancialAttempt>;
  function Editor() { current = useFinancialAttempt(user, acceptedEditor); return null; }
  const view = (visible: boolean) => <MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}>{visible && <Editor />}</MoneyLifetimeProvider>;
  const { rerender } = render(view(true));
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const command = intent(); let saving!: Promise<void>;
  await act(async () => { saving = current.submit(command); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  rerender(view(false));
  await act(async () => { finish(reply(accepted)); await saving; });
  expect(recorded).toHaveBeenCalledExactlyOnceWith(reference, command.operationId);
  expect(acceptedEditor).not.toHaveBeenCalled(); expect(await attempts.readAttempt(user)).toBeNull();
});
it("announces an old acceptance but shows and protects the newer retained slot without dismissing the editor", async () => {
  const recorded = vi.fn(); const acceptedEditor = vi.fn();
  const { result } = renderHook(() => useFinancialAttempt(user, acceptedEditor), { wrapper: ({ children }) => <MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}>{children}</MoneyLifetimeProvider> });
  let finish!: (value: Response) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const oldCommand = intent(); let saving!: Promise<void>;
  await act(async () => { saving = result.current.submit(oldCommand); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  vi.mocked(fetch).mockResolvedValueOnce(reply(reference)); await attempts.checkAttempt(user);
  const newer = intent(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await attempts.submitAttempt(user, newer);
  await act(async () => { finish(reply(accepted)); await saving; });
  expect(recorded).toHaveBeenCalledExactlyOnceWith(reference, oldCommand.operationId);
  expect(acceptedEditor).not.toHaveBeenCalled(); expect(result.current.accepted).toBeUndefined();
  expect(result.current.attempt?.command).toEqual(newer); expect(result.current.pending).toBe(false);
  expect((await attempts.readAttempt(user))?.command).toEqual(newer);
});
it("settles both overlapping recovery hooks and deduplicates their shared acceptance", async () => {
  const command = intent(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await attempts.submitAttempt(user, command);
  const recorded = vi.fn(); const firstAccepted = vi.fn(); const secondAccepted = vi.fn();
  const { result } = renderHook(() => ({ first: useFinancialAttempt(user, firstAccepted), second: useFinancialAttempt(user, secondAccepted) }), { wrapper: ({ children }) => <MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}>{children}</MoneyLifetimeProvider> });
  const finishes: ((value: Response) => void)[] = []; vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  let first!: Promise<void>; let second!: Promise<void>;
  await act(async () => { first = result.current.first.check(); second = result.current.second.check(); });
  await waitFor(() => expect(finishes).toHaveLength(2));
  await act(async () => { finishes[0](reply(reference)); await first; });
  await act(async () => { finishes[1](reply(reference)); await second; });
  expect(result.current.first.pending).toBe(false); expect(result.current.second.pending).toBe(false);
  expect(firstAccepted).toHaveBeenCalledOnce(); expect(secondAccepted).toHaveBeenCalledOnce(); expect(recorded).toHaveBeenCalledExactlyOnceWith(reference, command.operationId);
});
it("suppresses an old identity's acceptance and cannot release the new identity's pending invocation", async () => {
  const acceptedEditor = vi.fn(); const recorded = vi.fn(); const bob = { ...user, id: "bob" }; let owner = user;
  const { result, rerender } = renderHook(({ person }) => useFinancialAttempt(person, acceptedEditor), { initialProps: { person: user }, wrapper: ({ children }) => <MoneyLifetimeProvider user={owner} onRecorded={recorded} onGuardChange={vi.fn()}>{children}</MoneyLifetimeProvider> });
  let oldFinish!: (value: Response) => void; let newFinish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve; }));
  let oldSave!: Promise<void>; await act(async () => { oldSave = result.current.submit(intent()); });
  await waitFor(() => expect(oldFinish).toBeTypeOf("function"));
  setActiveMemberId(bob.id); publishAccessBoundary("ready", bob); resumeHouseholdWork(); await homeOSDatabase.householdCache.clear();
  owner = bob; rerender({ person: bob });
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { newFinish = resolve; }));
  let newSave!: Promise<void>; await act(async () => { newSave = result.current.submit(intent()); });
  await waitFor(() => expect(newFinish).toBeTypeOf("function"));
  await act(async () => { oldFinish(reply(accepted)); await oldSave; });
  expect(result.current.pending).toBe(true); expect(recorded).not.toHaveBeenCalled(); expect(acceptedEditor).not.toHaveBeenCalled();
  await act(async () => { newFinish(reply({ ...accepted, comment: { ...accepted.comment, authorId: "bob" } })); await newSave; });
  expect(result.current.pending).toBe(false); expect(acceptedEditor).toHaveBeenCalledOnce();
});
it("invalidates captured application publication capabilities when the owner changes identity or unmounts", async () => {
  const recorded = vi.fn(); let lifetime!: ReturnType<typeof useMoneyLifetime>;
  function Capture() { lifetime = useMoneyLifetime(); return null; }
  const { rerender, unmount } = render(<MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}><Capture /></MoneyLifetimeProvider>);
  const oldOwner = lifetime;
  const { runHouseholdWork } = await import("@/auth/work");
  await runHouseholdWork(async lease => {
    rerender(<MoneyLifetimeProvider user={{ ...user, role: "viewer" }} onRecorded={recorded} onGuardChange={vi.fn()}><Capture /></MoneyLifetimeProvider>);
    oldOwner?.publishAccepted(lease, "old", reference);
    const currentOwner = lifetime; unmount(); currentOwner?.publishAccepted(lease, "unmounted", reference);
  });
  expect(recorded).not.toHaveBeenCalled();
});

it("bounds transient owner announcement deduplication to the most recent 128 operations", async () => {
  const recorded = vi.fn();
  const { result } = renderHook(() => useMoneyLifetime(), { wrapper: ({ children }) => <MoneyLifetimeProvider user={user} onRecorded={recorded} onGuardChange={vi.fn()}>{children}</MoneyLifetimeProvider> });
  const { runHouseholdWork } = await import("@/auth/work");
  await runHouseholdWork(async lease => {
    for (let i = 0; i < 130; i++) result.current?.publishAccepted(lease, String(i), reference);
    result.current?.publishAccepted(lease, "129", reference);
    expect(recorded).toHaveBeenCalledTimes(130);
    result.current?.publishAccepted(lease, "0", reference);
    expect(recorded).toHaveBeenCalledTimes(131);
  });
});

it.each(["expense", "financial"] as const)("releases only the accepting %s editor's own token before its navigation callback", async kind => {
  let guarded = false; const observed = vi.fn();
  function OtherEditor() { useMoneyGuard(true); return null; }
  const acceptedCallback = () => { observed(guarded); };
  const members = [{ id: "alice", name: "Alice", active: true }];
  const view = (other: boolean) => <MoneyLifetimeProvider user={user} onRecorded={vi.fn()} onGuardChange={value => { guarded = value; }}>
    {kind === "expense" ? <EntryDialog user={user} members={members} onAccepted={acceptedCallback} onClose={vi.fn()} /> : <FinancialDialog user={user} members={members} title="Comment" onAccepted={acceptedCallback} onClose={vi.fn()} dirty command={{ action: "comment", entryId: "entry", expectedVersion: 1, text: "Dinner" }}><span>Comment draft</span></FinancialDialog>}
    {other && <OtherEditor />}
  </MoneyLifetimeProvider>;
  const { rerender } = render(view(false));
  if (kind === "expense") {
    await screen.findByLabelText("Description");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Dinner" } });
    fireEvent.change(screen.getByLabelText("Bill amount"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Paid by Alice"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Alice" }));
  }
  await waitFor(() => expect(guarded).toBe(true));
  vi.mocked(fetch).mockImplementation(async (_path, init) => {
    if (kind === "financial") return reply(accepted);
    const input = JSON.parse(String(init?.body));
    return reply({ status: "accepted", entry: { id: "bill", householdId: "home", version: 1, lifecycle: "effective", intent: input, payers: input.payers, shares: input.payers, createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-19T00:00:00Z" } });
  });
  fireEvent.click(await screen.findByRole("button", { name: kind === "expense" ? "Save expense" : "Record" }));
  await waitFor(() => expect(observed).toHaveBeenCalledExactlyOnceWith(false));
  rerender(view(true)); await waitFor(() => expect(guarded).toBe(true));
  rerender(view(false)); await waitFor(() => expect(guarded).toBe(false));
});
it("keeps another editor guarded while an accepted editor releases its own token for navigation", async () => {
  let guarded = false; const observed = vi.fn();
  function OtherEditor() { useMoneyGuard(true); return null; }
  const view = (other: boolean) => <MoneyLifetimeProvider user={user} onRecorded={vi.fn()} onGuardChange={value => { guarded = value; }}>
    <FinancialDialog user={user} members={[]} title="Comment" onAccepted={() => { observed(guarded); }} onClose={vi.fn()} dirty command={{ action: "comment", entryId: "entry", expectedVersion: 1, text: "Dinner" }}><span>Comment draft</span></FinancialDialog>
    {other && <OtherEditor />}
  </MoneyLifetimeProvider>;
  const { rerender } = render(view(true)); await waitFor(() => expect(guarded).toBe(true));
  vi.mocked(fetch).mockResolvedValueOnce(reply(accepted));
  fireEvent.click(await screen.findByRole("button", { name: "Record" }));
  await waitFor(() => expect(observed).toHaveBeenCalledExactlyOnceWith(true));
  expect(guarded).toBe(true); rerender(view(false)); await waitFor(() => expect(guarded).toBe(false));
});

it("preserves the owner for referential same-person refresh but permanently invalidates it across away-and-back identity changes", async () => {
  let lifetime!: ReturnType<typeof useMoneyLifetime>; let guarded = false; const recorded = vi.fn();
  function Editor() { lifetime = useMoneyLifetime(); useMoneyGuard(true); return null; }
  const view = (person: AuthUser) => <MoneyLifetimeProvider user={person} onRecorded={recorded} onGuardChange={value => { guarded = value; }}><Editor /></MoneyLifetimeProvider>;
  const { rerender } = render(view(user)); const original = lifetime;
  await waitFor(() => expect(guarded).toBe(true));
  rerender(view({ ...user, name: "Alice refreshed" }));
  expect(lifetime).toBe(original); expect(guarded).toBe(true);
  rerender(view({ ...user, id: "bob" })); rerender(view({ ...user }));
  expect(lifetime).not.toBe(original); await waitFor(() => expect(guarded).toBe(true));
  const { runHouseholdWork } = await import("@/auth/work");
  await runHouseholdWork(async lease => {
    original?.publishAccepted(lease, "old-owner", reference);
    expect(recorded).not.toHaveBeenCalled();
    lifetime?.publishAccepted(lease, "current-owner", reference);
    expect(recorded).toHaveBeenCalledExactlyOnceWith(reference, "current-owner");
  });
});

it("refreshes mounted personal and detail reads from owner-only acceptance without changing the stable capability", async () => {
  let revision = 1;
  vi.mocked(fetch).mockImplementation(async path => reply({ revision, value: String(path) }));
  const valid = (v: unknown): v is { revision: number; value: string } => !!v && typeof v === "object" && "revision" in v && typeof v.revision === "number" && "value" in v && typeof v.value === "string";
  const { result } = renderHook(() => ({ lifetime: useMoneyLifetime(), signal: useMoneyReadSignal(), personal: useLedgerRead(user, "/api/v1/ledger/balances?memberId=alice", valid), detail: useLedgerRead(user, "/api/v1/ledger/entries/entry", valid, "detail") }), { wrapper: ({ children }) => <MoneyLifetimeProvider user={user} onRecorded={vi.fn()} onGuardChange={vi.fn()}>{children}</MoneyLifetimeProvider> });
  await waitFor(() => { expect(result.current.personal.copy?.data.revision).toBe(1); expect(result.current.detail.copy?.data.revision).toBe(1); });
  const capability = result.current.lifetime; const initialSignal = result.current.signal; expect(fetch).toHaveBeenCalledTimes(2);
  const { runHouseholdWork } = await import("@/auth/work"); revision = 2;
  await act(async () => { await runHouseholdWork(async lease => { capability?.publishAccepted(lease, "owner-only", reference); }); });
  await waitFor(() => { expect(result.current.personal.copy?.data.revision).toBe(2); expect(result.current.detail.copy?.data.revision).toBe(2); });
  expect(result.current.lifetime).toBe(capability); expect(result.current.signal).not.toBe(initialSignal); expect(fetch).toHaveBeenCalledTimes(4);
  const acceptedSignal = result.current.signal;
  await act(async () => { await runHouseholdWork(async lease => { capability?.publishAccepted(lease, "owner-only", reference); }); });
  expect(result.current.signal).toBe(acceptedSignal); expect(fetch).toHaveBeenCalledTimes(4);
  await act(async () => { await runHouseholdWork(async lease => {
    resumeHouseholdWork();
    expect(() => capability?.publishAccepted(lease, "invalidated-lease", reference)).toThrow(/access changed/i);
  }); });
  expect(result.current.signal).toBe(acceptedSignal); expect(fetch).toHaveBeenCalledTimes(4);
});

it("hides an old refusal handoff when the editor discovers a newer retained save without releasing its guard", async () => {
  let guarded = false; const handoff = vi.fn();
  render(<MoneyLifetimeProvider user={user} onRecorded={vi.fn()} onGuardChange={value => { guarded = value; }}><FinancialDialog user={user} members={[]} title="Comment" onAccepted={vi.fn()} onClose={vi.fn()} dirty command={{ action: "comment", entryId: "entry", expectedVersion: 1, text: "Dinner" }} refusalContent={(_error, releaseOwnGuard) => <button type="button" onClick={() => { releaseOwnGuard(); handoff(); }}>Open existing original</button>}><span>Comment draft</span></FinancialDialog></MoneyLifetimeProvider>);
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "conflict", message: "Original exists" } }), { status: 409 }));
  fireEvent.click(await screen.findByRole("button", { name: "Record" }));
  expect(await screen.findByRole("button", { name: "Open existing original" })).toBeInTheDocument();
  const newer = intent(); vi.mocked(fetch).mockRejectedValueOnce(new TypeError("lost")); await attempts.submitAttempt(user, newer);
  const before = await homeOSDatabase.householdCache.toArray();
  window.dispatchEvent(new Event("focus"));
  await screen.findByRole("heading", { name: "Save outcome unknown" });
  expect(screen.queryByRole("button", { name: "Open existing original" })).not.toBeInTheDocument();
  expect(guarded).toBe(true); expect(handoff).not.toHaveBeenCalled(); expect(await homeOSDatabase.householdCache.toArray()).toEqual(before);
});
