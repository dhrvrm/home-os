import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@/lib/auth";
import { clearSavedSession, readSavedSession, saveSession } from "./session";

const session: AuthSession = {
  user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "member" },
  expiresAt: "2026-12-01T12:00:00.000Z",
};

afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.useRealTimers(); });

describe("remembered access evidence", () => {
  it("stores only a validated non-secret snapshot and expires it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
    saveSession(session);
    expect(readSavedSession()).toEqual(session);
    expect(localStorage.length).toBe(1);
    expect(JSON.stringify(localStorage)).not.toMatch(/password|token|cookie/i);
    vi.setSystemTime(new Date("2026-12-02T12:00:00.000Z"));
    expect(readSavedSession()).toBeNull();
  });

  it("does not persist ordinary sign-in across a browser-session restart", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
    const shortSession = { ...session, expiresAt: "2026-11-06T23:00:00.000Z" };
    saveSession(shortSession);
    expect(readSavedSession()).toEqual(shortSession);
    sessionStorage.clear();
    expect(readSavedSession()).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("removes cached evidence on an explicit server rejection", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:00.000Z"));
    saveSession(session);
    clearSavedSession();
    expect(readSavedSession()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
