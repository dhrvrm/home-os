import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMembers, listBrowserSessions, revokeBrowserSession, type AuthSession } from "@/lib/auth";
import { homeOSDatabase } from "@/offline/db";
import { AccessRosters } from "./access-rosters";
import { listConnections, revokeConnection } from "./connections";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "./work";
vi.mock("@/lib/auth", () => ({ getMembers: vi.fn(), listBrowserSessions: vi.fn(), revokeBrowserSession: vi.fn() }));
vi.mock("./connections", () => ({ listConnections: vi.fn(), revokeConnection: vi.fn() }));
const session: AuthSession = { sessionId: "a".repeat(32), user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "viewer" }, expiresAt: null };
const connection = { id: "c".repeat(32), memberId: "alice", clientId: "client", clientName: "My assistant", resource: "https://home.dhruvverma.dev/mcp", approvedRole: "viewer" as const, status: "authorized" as const, createdAt: "2026-11-18T10:00:00Z", approvedAt: null, endedAt: null };
beforeEach(() => { vi.resetAllMocks(); resumeHouseholdWork(); setActiveMemberId("alice"); publishAccessBoundary("ready", session.user); vi.mocked(getMembers).mockResolvedValue([{ ...session.user, active: true, hasLogin: true }, { id: "bob", name: "Bob", email: "bob@example.com", role: "member", active: true, hasLogin: true }]); vi.mocked(listBrowserSessions).mockResolvedValue({ sessions: [{ id: "s", memberId: "alice", current: true, createdAt: "2026-11-18T10:00:00Z", expiresAt: null }], nextCursor: null }); vi.mocked(listConnections).mockResolvedValue({ connections: [connection], nextCursor: null }); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function show(extra: Partial<Parameters<typeof AccessRosters>[0]> = {}) { return render(<AccessRosters session={session} online hasPendingChanges={false} {...extra} />); }
it("shows personal access to Viewers and prevents unsafe current-browser revocation with queued work", async () => {
  show({ hasPendingChanges: true });
  expect(await screen.findByRole("button", { name: "End access for this browser" })).toBeDisabled();
  expect(screen.getByText(/Sync your saved changes before ending/)).toBeInTheDocument();
  expect(await screen.findByText("Authorized")).toBeInTheDocument();
  expect(screen.queryByLabelText("Show access for")).not.toBeInTheDocument();
  expect(getMembers).not.toHaveBeenCalled();
});
it("retains active connection after failure, prevents duplicate revoke, then shows accepted end", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(revokeConnection).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue({ id: connection.id, revoked: true });
  show(); const end = await screen.findByRole("button", { name: "End access for My assistant" });
  fireEvent.click(end); fireEvent.click(end);
  expect(revokeConnection).toHaveBeenCalledOnce();
  await act(async () => fail(new Error("Connection failed. Try again.")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection failed");
  expect(screen.getByText("Authorized")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "End access for My assistant" }));
  expect(await screen.findByText("Ended")).toBeInTheDocument();
});
it("pages the connection list and lets owners select a household person", async () => {
  vi.mocked(listConnections).mockResolvedValueOnce({ connections: [connection], nextCursor: "d".repeat(32) }).mockResolvedValue({ connections: [{ ...connection, id: "e".repeat(32), clientName: "Second assistant", status: "not_used_yet" }], nextCursor: null });
  show({ session: { ...session, user: { ...session.user, role: "owner" } } });
  fireEvent.click(await screen.findByRole("button", { name: "Load more assistant connections" }));
  expect(await screen.findByText("Second assistant")).toBeInTheDocument();
  expect(screen.getByText("My assistant")).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText("Show access for"), { target: { value: "bob" } });
  await waitFor(() => expect(listBrowserSessions).toHaveBeenLastCalledWith({ memberId: "bob", limit: 10 }));
  expect(screen.getByRole("link", { name: "Manage household members" })).toHaveAttribute("href", "/?view=members");
});
it("offers retry for list errors and gives truthful empty and offline states", async () => {
  vi.mocked(listConnections).mockRejectedValueOnce(new Error("List unavailable")).mockResolvedValue({ connections: [], nextCursor: null });
  const view = show();
  expect(await screen.findByRole("alert")).toHaveTextContent("List unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry assistant connections" }));
  expect(await screen.findByText("No assistant connections to show.")).toBeInTheDocument();
  view.rerender(<AccessRosters session={session} online={false} hasPendingChanges={false} />);
  const roster = screen.getByRole("region", { name: "Browser sessions" });
  expect(within(roster).getByText(/Connect to check or end access/)).toBeInTheDocument();
  expect(within(roster).getByRole("button", { name: "End access for this browser" })).toBeDisabled();
});

it("rechecks queued work at the current-session revoke gesture", async () => {
  vi.spyOn(homeOSDatabase.outbox, "count").mockResolvedValueOnce(1);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "End access for this browser" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Sync your saved changes");
  expect(revokeBrowserSession).not.toHaveBeenCalled();
});

it("refreshes an unsettled list after reconnect instead of retaining its stale response", async () => {
  let finish!: (value: Awaited<ReturnType<typeof listConnections>>) => void;
  vi.mocked(listConnections).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ connections: [{ ...connection, status: "ended" }], nextCursor: null });
  const view = show();
  await waitFor(() => expect(listConnections).toHaveBeenCalledOnce());
  view.rerender(<AccessRosters session={session} online={false} hasPendingChanges={false} />);
  view.rerender(<AccessRosters session={session} online hasPendingChanges={false} />);
  await act(async () => finish({ connections: [connection], nextCursor: null }));
  await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Ended")).toBeInTheDocument();
  expect(screen.queryByText("Authorized")).not.toBeInTheDocument();
});

it("does not report an empty roster before its first successful response", async () => {
  let finish!: (value: Awaited<ReturnType<typeof listConnections>>) => void;
  vi.mocked(listConnections).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = show();
  await waitFor(() => expect(listConnections).toHaveBeenCalledOnce());
  view.rerender(<AccessRosters session={session} online={false} hasPendingChanges={false} />);
  view.rerender(<AccessRosters session={session} online hasPendingChanges={false} />);
  await act(async () => { await Promise.resolve(); });
  try {
    expect(screen.queryByText("No assistant connections to show.")).not.toBeInTheDocument();
  } finally {
    await act(async () => finish({ connections: [connection], nextCursor: null }));
  }
});

it.each(["accepted", "refused"] as const)("refreshes after reconnect during a %s revocation and preserves its outcome", async outcome => {
  let finish!: (value: { id: string; revoked: true }) => void;
  let fail!: (error: Error) => void;
  vi.mocked(revokeConnection).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  vi.mocked(listConnections).mockResolvedValueOnce({ connections: [connection], nextCursor: null })
    .mockResolvedValue({ connections: [{ ...connection, id: "f".repeat(32), clientName: "Current assistant" }], nextCursor: null });
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "End access for My assistant" }));
  expect(revokeConnection).toHaveBeenCalledOnce();
  view.rerender(<AccessRosters session={session} online={false} hasPendingChanges={false} />);
  view.rerender(<AccessRosters session={session} online hasPendingChanges={false} />);
  await act(async () => {
    if (outcome === "accepted") finish({ id: connection.id, revoked: true });
    else fail(new Error("Access could not be ended. Try again."));
  });
  await waitFor(() => expect(listConnections).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Current assistant")).toBeInTheDocument();
  if (outcome === "accepted") expect(screen.getByText("Access ended.")).toBeInTheDocument();
  else expect(screen.getByRole("alert")).toHaveTextContent("Access could not be ended");
  expect(revokeConnection).toHaveBeenCalledOnce();
});
