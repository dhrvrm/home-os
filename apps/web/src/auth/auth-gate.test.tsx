import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthStatus, logout, type AuthSession } from "@/lib/auth";
import { APIError } from "@/lib/api";
import { createLocalItem } from "@/offline/commands";
import { homeOSDatabase } from "@/offline/db";
import { loadInventoryCache, saveInventoryCache } from "@/lib/inventory-cache";
import { AuthGate } from "./auth-gate";
import { readSavedSession, saveSession, setDataOwner } from "./session";
import { ACCESS_BOUNDARY_KEY, publishAccessBoundary, readAccessBoundary, resumeHouseholdWork, runHouseholdWork } from "./work";

const alice: AuthSession = { user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "member" }, expiresAt: "2099-12-01T00:00:00.000Z" };
const bob: AuthSession = { user: { id: "bob", householdId: "home", name: "Bob", email: "bob@example.com", role: "member" }, expiresAt: "2099-12-01T00:00:00.000Z" };

vi.mock("@/lib/auth", () => ({ getAuthStatus: vi.fn(), logout: vi.fn() }));
vi.mock("@/components/inventory-app", () => ({ InventoryApp: ({ session, onLogout }: { session: AuthSession; onLogout: () => Promise<void> }) => <div>Open {session.user.name}<input aria-label="Unsaved note" defaultValue="" /><button onClick={() => void onLogout().catch(() => {})}>Sign out test</button></div> }));
vi.mock("@/components/auth-screen", () => ({ AuthScreen: ({ setupRequired, onAuthenticated, message }: { setupRequired: boolean; onAuthenticated: (session: AuthSession) => Promise<void>; message?: string }) => <div>{setupRequired ? "Set up test" : "Sign in test"}<p>{message}</p><button onClick={() => void onAuthenticated(alice).catch(() => {})}>Sign in Alice</button><button onClick={() => void onAuthenticated(bob).catch(() => {})}>Sign in Bob</button></div> }));

beforeEach(async () => {
  vi.mocked(getAuthStatus).mockReset();
  vi.mocked(logout).mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  localStorage.clear();
  sessionStorage.clear();
  resumeHouseholdWork();
  await homeOSDatabase.delete();
  await homeOSDatabase.open();
});
afterEach(async () => { cleanup(); await homeOSDatabase.delete(); localStorage.clear(); sessionStorage.clear(); resumeHouseholdWork(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function queueAliceWork() {
  setDataOwner(alice.user);
  await createLocalItem(homeOSDatabase, { name: "Alice soap" });
}

describe("member access gate", () => {
  it("opens an unexpired same-member offline copy after a transport failure", async () => {
    saveSession(alice); setDataOwner(alice.user); publishAccessBoundary("ready");
    vi.mocked(getAuthStatus).mockRejectedValue(new APIError("Offline", "offline"));
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
  });

  it("does not fall back to remembered access after an explicit online rejection", async () => {
    saveSession(alice); setDataOwner(alice.user); publishAccessBoundary("ready");
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: null });
    render(<AuthGate />);
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    expect(screen.queryByText("Open Alice")).not.toBeInTheDocument();
    expect(readSavedSession()).toBeNull();
  });

  it("preserves queued work when the same member signs in again", async () => {
    await queueAliceWork();
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: null });
    render(<AuthGate />);
    fireEvent.click(await screen.findByText("Sign in Alice"));
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    expect(await homeOSDatabase.outbox.count()).toBe(1);
    expect((await homeOSDatabase.items.toArray())[0]?.name).toBe("Alice soap");
  });

  it("requires explicit discard before another account can adopt the device", async () => {
    await queueAliceWork();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: null });
    render(<AuthGate />);
    fireEvent.click(await screen.findByText("Sign in Bob"));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
    expect(screen.queryByText("Open Bob")).not.toBeInTheDocument();
    expect(await homeOSDatabase.outbox.count()).toBe(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("Sign in Bob"));
    expect(await screen.findByText("Open Bob")).toBeInTheDocument();
    expect(await homeOSDatabase.outbox.count()).toBe(0);
    expect(await homeOSDatabase.items.count()).toBe(0);
  });

  it("clears local household state after successful server logout", async () => {
    await queueAliceWork();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    fireEvent.click(await screen.findByText("Sign out test"));
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    expect(logout).toHaveBeenCalledOnce();
    expect(await homeOSDatabase.outbox.count()).toBe(0);
    expect(await homeOSDatabase.items.count()).toBe(0);
    expect(readSavedSession()).toBeNull();
  });

  it("locks immediately when another tab changes the access boundary", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    const value = JSON.stringify({ state: "signed-out", generation: "other-tab" });
    localStorage.setItem(ACCESS_BOUNDARY_KEY, value);
    fireEvent(window, new StorageEvent("storage", { key: ACCESS_BOUNDARY_KEY, newValue: value }));
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    expect(readSavedSession()).toBeNull();
  });

  it("expires while disconnected without discarding the member's outbox", async () => {
    await queueAliceWork();
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-06T12:00:00.000Z");
    vi.setSystemTime(start);
    const timer = vi.spyOn(window, "setTimeout");
    const short = { ...alice, expiresAt: new Date(start.getTime() + 60_000).toISOString() };
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: short });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const scheduled = timer.mock.calls.find(([, delay]) => delay === 60_000);
    expect(scheduled).toBeDefined();
    vi.setSystemTime(new Date(start.getTime() + 60_001));
    act(() => { (scheduled![0] as () => void)(); });
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    expect(readSavedSession()).toBeNull();
    expect(await homeOSDatabase.outbox.count()).toBe(1);
  });

  it("waits for old work before clearing and cannot accept its late write", async () => {
    setDataOwner(alice.user);
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    let finish!: () => void;
    const pending = runHouseholdWork(async (lease) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      lease.check();
      await createLocalItem(homeOSDatabase, { name: "Stale response" });
    });
    const rejected = expect(pending).rejects.toThrow("access changed");
    await Promise.resolve();
    fireEvent.click(screen.getByText("Sign out test"));
    expect(logout).not.toHaveBeenCalled();
    finish();
    await rejected;
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    expect(await homeOSDatabase.items.count()).toBe(0);
    expect(logout).toHaveBeenCalledOnce();
  });

  it("locks on server401 and cannot restore an old offline grant", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    fireEvent(window, new Event("home-os:session-expired"));
    expect(await screen.findByText("Sign in test")).toBeInTheDocument();
    vi.mocked(getAuthStatus).mockRejectedValue(new APIError("Offline", "offline"));
    fireEvent(window, new Event("online"));
    expect(await screen.findByRole("button", { name: "Retry connection" })).toBeInTheDocument();
    expect(screen.queryByText("Open Alice")).not.toBeInTheDocument();
  });

  it("keeps unsaved form state mounted during a successful same-member focus recheck", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Unsaved note"), { target: { value: "Keep this draft" } });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("Unsaved note")).toHaveValue("Keep this draft"));
  });

  it("clears an unowned legacy cache before a different member can import it", async () => {
    const item = await createLocalItem(homeOSDatabase, { name: "Previous owner inventory" });
    saveInventoryCache([item]);
    await Promise.all(homeOSDatabase.tables.map((table) => table.clear()));
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: bob });
    render(<AuthGate />);
    expect(await screen.findByText("Open Bob")).toBeInTheDocument();
    expect(loadInventoryCache()).toBeNull();
  });

  it("rechecks a stale successful status response before admitting it over another member's ready grant", async () => {
    setDataOwner(alice.user);
    let finish!: (status: { setupRequired: boolean; setupAvailable: boolean; session: AuthSession }) => void;
    vi.mocked(getAuthStatus).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: bob });
    render(<AuthGate />);
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledOnce());
    setDataOwner(bob.user);
    const bobItem = await createLocalItem(homeOSDatabase, { name: "Bob saved inventory" });
    await homeOSDatabase.outbox.clear();
    publishAccessBoundary("ready", bob.user);
    // The shared marker is visible before the corresponding storage event runs.
    finish({ setupRequired: false, setupAvailable: true, session: alice });
    expect(await screen.findByText("Open Bob")).toBeInTheDocument();
    expect((await homeOSDatabase.items.get(bobItem.id))?.name).toBe("Bob saved inventory");
    expect(getAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps a draft mounted when another tab establishes a fresh grant for the same member", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Unsaved note"), { target: { value: "Keep this draft" } });
    const value = JSON.stringify({ state: "ready", generation: "fresh-same-member-grant", memberId: alice.user.id, householdId: alice.user.householdId });
    localStorage.setItem(ACCESS_BOUNDARY_KEY, value);
    fireEvent(window, new StorageEvent("storage", { key: ACCESS_BOUNDARY_KEY, newValue: value }));
    expect(screen.getByLabelText("Unsaved note")).toHaveValue("Keep this draft");
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Unsaved note")).toHaveValue("Keep this draft");
  });

  it("ignores a failed request from an earlier grant after another tab signs in", async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    const earlier = readAccessBoundary();
    const value = JSON.stringify({ state: "ready", generation: "fresh-same-member-grant", memberId: alice.user.id, householdId: alice.user.householdId });
    localStorage.setItem(ACCESS_BOUNDARY_KEY, value);
    fireEvent(window, new StorageEvent("storage", { key: ACCESS_BOUNDARY_KEY, newValue: value }));
    await waitFor(() => expect(getAuthStatus).toHaveBeenCalledTimes(2));
    fireEvent(window, new CustomEvent("home-os:session-expired", { detail: { memberId: alice.user.id, boundary: earlier, generation: -1 } }));
    expect(screen.getByText("Open Alice")).toBeInTheDocument();
    expect(readSavedSession()?.user.id).toBe("alice");
    expect(readAccessBoundary()).toBe(value);
  });

  it("does not notify other tabs or discard a draft when sign-out is cancelled", async () => {
    await queueAliceWork();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Unsaved note"), { target: { value: "Keep this draft" } });
    const boundary = readAccessBoundary();
    fireEvent.click(screen.getByText("Sign out test"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(logout).not.toHaveBeenCalled();
    expect(readAccessBoundary()).toBe(boundary);
    expect(screen.getByLabelText("Unsaved note")).toHaveValue("Keep this draft");
    expect(await homeOSDatabase.outbox.count()).toBe(1);
  });

  it("ignores an already queued expiry callback after a fresh same-member grant was accepted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-06T12:00:00.000Z");
    vi.setSystemTime(start);
    const timer = vi.spyOn(window, "setTimeout");
    const short = { ...alice, expiresAt: new Date(start.getTime() + 60_000).toISOString() };
    vi.mocked(getAuthStatus).mockResolvedValueOnce({ setupRequired: false, setupAvailable: true, session: short });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    const queued = timer.mock.calls.find(([, delay]) => delay === 60_000);
    expect(queued).toBeDefined();
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    publishAccessBoundary("ready", alice.user);
    fireEvent(window, new StorageEvent("storage", { key: ACCESS_BOUNDARY_KEY, newValue: readAccessBoundary() }));
    await waitFor(() => expect(readSavedSession()?.expiresAt).toBe(alice.expiresAt));
    vi.setSystemTime(new Date(start.getTime() + 60_001));
    act(() => { (queued![0] as () => void)(); });
    expect(screen.getByText("Open Alice")).toBeInTheDocument();
    expect(readSavedSession()?.expiresAt).toBe(alice.expiresAt);
  });

  it("stays locked when server logout succeeds but clearing the device copy fails", async () => {
    await queueAliceWork();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(getAuthStatus).mockResolvedValue({ setupRequired: false, setupAvailable: true, session: alice });
    render(<AuthGate />);
    expect(await screen.findByText("Open Alice")).toBeInTheDocument();
    vi.spyOn(homeOSDatabase, "transaction").mockRejectedValueOnce(new Error("Device storage unavailable"));
    fireEvent.click(screen.getByText("Sign out test"));
    expect(await screen.findByRole("alert")).toHaveTextContent("saved device data could not be cleared");
    expect(screen.queryByText("Open Alice")).not.toBeInTheDocument();
    expect(logout).toHaveBeenCalledOnce();
    expect(readSavedSession()).toBeNull();
  });
});
