import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/auth";
import { ConnectionConsent } from "./connection-consent";
import { decideConsent, getConsent, type ConsentPreview } from "./connections";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "./work";

vi.mock("./connections", () => ({ getConsent: vi.fn(), decideConsent: vi.fn() }));
const session: AuthSession = { sessionId: "a".repeat(32), user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "viewer" }, expiresAt: null };
const preview: ConsentPreview = { id: "c".repeat(32), client: { clientId: "client", clientName: '<img src=x onerror="alert(1)">', redirectUri: "http://127.0.0.1:3000/callback", redirectHost: "127.0.0.1:3000", redirectIsLoopback: true, scope: ["home:access"] }, resource: "https://home.dhruvverma.dev/mcp", member: session.user, approvedRole: "viewer", capabilities: ["inventory_list", "notifications_mark_read", "connections_revoke"], expiresAt: new Date(Date.now() + 600_000).toISOString() };
beforeEach(() => { vi.resetAllMocks(); resumeHouseholdWork(); setActiveMemberId("alice"); publishAccessBoundary("ready", session.user); vi.mocked(getConsent).mockResolvedValue(preview); vi.mocked(decideConsent).mockResolvedValue({ redirectTo: "http://127.0.0.1:3000/callback?code=server-validated" }); });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function show(extra: Partial<Parameters<typeof ConnectionConsent>[0]> = {}) { return render(<ConnectionConsent intentId={preview.id} session={session} online onRedirect={vi.fn()} {...extra} />); }

it("escapes untrusted names, displays destination/loopback and personal capabilities, and never autoapproves", async () => {
  const view = show();
  expect(await screen.findByText(preview.client.clientName)).toBeInTheDocument();
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByText(/Unverified client name/)).toBeInTheDocument();
  expect(screen.getByText(/This returns to an app on your device/)).toBeInTheDocument();
  expect(screen.getByText(/Any local process may be listening/)).toBeInTheDocument();
  expect(screen.getByText("Mark your reminders read")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Return to Home OS" })).toHaveAttribute("href", "/");
  expect(decideConsent).not.toHaveBeenCalled();
});
it("shows a verified domain prominently without loading an untrusted logo", async () => {
  vi.mocked(getConsent).mockResolvedValue({ ...preview, client: { ...preview.client, clientDomain: "assistant.example", logoUri: "https://evil.example/logo" } });
  const view = show();
  expect(await screen.findByText("assistant.example")).toBeInTheDocument();
  expect(screen.queryByText(/Unverified client name/)).not.toBeInTheDocument();
  expect(view.container.querySelector("img")).toBeNull();
});
it.each(["approve", "deny"] as const)("performs only explicit %s and uses only the server callback", async decision => {
  window.history.replaceState(null, "", "/?redirect=https://evil.example");
  const redirect = vi.fn(); show({ onRedirect: redirect });
  fireEvent.click(await screen.findByRole("button", { name: decision === "approve" ? "Allow" : "Deny" }));
  await waitFor(() => expect(decideConsent).toHaveBeenCalledWith(preview.id, decision));
  expect(redirect).toHaveBeenCalledWith("http://127.0.0.1:3000/callback?code=server-validated");
});
it("blocks duplicate decisions and requires another preview after a refusal", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(decideConsent).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  show(); const allow = await screen.findByRole("button", { name: "Allow" });
  fireEvent.click(allow); fireEvent.click(allow);
  expect(decideConsent).toHaveBeenCalledOnce();
  await act(async () => fail(new Error("The reviewed account changed.")));
  expect(await screen.findByRole("alert")).toHaveTextContent("reviewed account changed");
  expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review again" }));
  expect(await screen.findByRole("button", { name: "Allow" })).toBeEnabled();
  expect(getConsent).toHaveBeenCalledTimes(2);
});
it("cannot approve a preview after another account takes the device", async () => {
  show(); const allow = await screen.findByRole("button", { name: "Allow" });
  publishAccessBoundary("ready", { id: "bob", householdId: "home" }); setActiveMemberId("bob");
  fireEvent.click(allow);
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in changed");
  expect(decideConsent).not.toHaveBeenCalled();
});
it("makes offline and expired states non-authorizing and offers a retry", async () => {
  const view = show({ online: false });
  expect(screen.getByText(/You’re offline/)).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Review again" })).toBeDisabled();
  expect(getConsent).not.toHaveBeenCalled();
  vi.mocked(getConsent).mockResolvedValue({ ...preview, expiresAt: "2000-01-01T00:00:00Z" });
  view.rerender(<ConnectionConsent intentId={preview.id} session={session} online onRedirect={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("expired");
  expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  expect(decideConsent).not.toHaveBeenCalled();
});
it("retries a failed preview without approving anything", async () => {
  vi.mocked(getConsent).mockRejectedValueOnce(new Error("Temporarily unavailable")); show();
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporarily unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Review again" }));
  expect(await screen.findByRole("button", { name: "Allow" })).toBeEnabled();
  expect(decideConsent).not.toHaveBeenCalled();
});
