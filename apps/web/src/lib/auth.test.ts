import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request } from "./api";
import { revokeBrowserSession } from "./auth";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";

vi.mock("./api", () => ({ request: vi.fn() }));
beforeEach(() => {
  resumeHouseholdWork();
  setActiveMemberId("alice");
  publishAccessBoundary("ready", { id: "alice", householdId: "home" });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); setActiveMemberId(null); });

it("signals the current access boundary to lock immediately after accepted self-revocation", async () => {
  const event = vi.fn();
  window.addEventListener("home-os:session-expired", event);
  try {
    vi.mocked(request).mockResolvedValue({ id: "device", revoked: true, current: true });
    expect(await revokeBrowserSession("device")).toEqual({ id: "device", revoked: true, current: true });
    expect(event).toHaveBeenCalledOnce();
  } finally { window.removeEventListener("home-os:session-expired", event); }
});

it("retains the current grant when revoking a different device", async () => {
  const event = vi.fn();
  window.addEventListener("home-os:session-expired", event);
  try {
    vi.mocked(request).mockResolvedValue({ id: "other", revoked: true, current: false });
    await revokeBrowserSession("other");
    expect(event).not.toHaveBeenCalled();
  } finally { window.removeEventListener("home-os:session-expired", event); }
});

it("does not lock a new account when an older grant's revoke response arrives late", async () => {
  const event = vi.fn();
  window.addEventListener("home-os:session-expired", event);
  try {
    let finish!: (value: unknown) => void;
    vi.mocked(request).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const response = revokeBrowserSession("device");
    setActiveMemberId("bob");
    publishAccessBoundary("ready", { id: "bob", householdId: "home" });
    finish({ id: "device", revoked: true, current: true });
    await response;
    expect(event).not.toHaveBeenCalled();
  } finally { window.removeEventListener("home-os:session-expired", event); }
});
