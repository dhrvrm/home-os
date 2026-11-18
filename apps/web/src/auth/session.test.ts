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
  it("persists an explicit permanent snapshot across browser restart and former deadlines", () => {
    const permanent = { ...session, expiresAt: null };
    saveSession(permanent);
    sessionStorage.clear();
    expect(readSavedSession(Date.parse("2099-01-01"))).toEqual(permanent);
  });

  it.each([undefined, "", "bad", "1", "2026-11-18", 0, false])("never treats malformed deadline %s as permanent", (expiresAt) => {
    localStorage.setItem("home-os:session:v1", JSON.stringify({ ...session, expiresAt }));
    expect(readSavedSession()).toBeNull();
  });

});

it("retains a valid public grant id while reading legacy snapshots compatibly", () => {
  const modern = { ...session, expiresAt: null, sessionId: "a".repeat(32) };
  saveSession(modern);
  expect(readSavedSession()).toEqual(modern);
});

it.each(["", "A".repeat(32), "a".repeat(31), "../session", 123])("rejects malformed public session ids %s", sessionId => {
  localStorage.setItem("home-os:session:v1", JSON.stringify({ ...session, expiresAt: null, sessionId }));
  expect(readSavedSession()).toBeNull();
});
