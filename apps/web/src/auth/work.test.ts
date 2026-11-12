import { afterEach, describe, expect, it, vi } from "vitest";
import { drainHouseholdWork, lockHouseholdWork, publishAccessBoundary, resumeHouseholdWork, runHouseholdWork, setActiveMemberId } from "./work";

afterEach(() => { resumeHouseholdWork(); setActiveMemberId(null); localStorage.clear(); });

describe("household work admission", () => {
  it("notifies the service worker of a new access boundary without passing credentials", () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    const postMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage } } });
    try {
      publishAccessBoundary("signed-out");
      expect(postMessage).toHaveBeenCalledWith({ type: "HOMEOS_ACCESS_BOUNDARY", state: "signed-out" });
    } finally {
      if (previous) Object.defineProperty(navigator, "serviceWorker", previous);
      else Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });
  it("drains in-flight work and prevents its late response from writing after lock", async () => {
    let finish!: () => void;
    let wrote = false;
    const task = runHouseholdWork(async (lease) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      lease.check();
      wrote = true;
    });
    await Promise.resolve();
    lockHouseholdWork();
    finish();
    await expect(task).rejects.toThrow("access changed");
    await drainHouseholdWork();
    expect(wrote).toBe(false);
    await expect(runHouseholdWork(async () => {})).rejects.toThrow("access changed");
  });

  it("binds work to its admitted member and stops new work on a shared-tab lock", async () => {
    setActiveMemberId("alice");
    let finish!: () => void;
    const task = runHouseholdWork(async (lease) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return lease.memberId;
    });
    await Promise.resolve();
    setActiveMemberId("bob");
    finish();
    expect(await task).toBe("alice");
    publishAccessBoundary("locked");
    await expect(runHouseholdWork(async () => {})).rejects.toThrow("access changed");
  });

  it("keeps same-member work admitted across another tab's fresh ready grant", async () => {
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    let finish!: () => void;
    const task = runHouseholdWork(async (lease) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      lease.check();
      return lease.memberId;
    });
    await Promise.resolve();
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    finish();
    await expect(task).resolves.toBe("alice");
  });

  it("rejects late work when another tab's ready grant belongs to someone else", async () => {
    setActiveMemberId("alice");
    publishAccessBoundary("ready", { id: "alice", householdId: "home" });
    let finish!: () => void;
    const task = runHouseholdWork(async (lease) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      lease.check();
    });
    await Promise.resolve();
    publishAccessBoundary("ready", { id: "bob", householdId: "home" });
    await expect(runHouseholdWork(async () => "must not start for Alice")).rejects.toThrow("access changed");
    finish();
    await expect(task).rejects.toThrow("access changed");
  });
});
