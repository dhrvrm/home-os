import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { changePassword, getAuthStatus, login, setupOwner } from "@/lib/auth";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "./work";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
function locks() {
  type Entry = { action: (lock: Lock) => Promise<unknown>; resolve(value: unknown): void; reject(reason: unknown): void; signal?: AbortSignal; abort(): void };
  const queue: Entry[] = [];
  let active = false;
  function pump() {
    if (active || queue.length === 0) return;
    const entry = queue.shift()!;
    entry.signal?.removeEventListener("abort", entry.abort);
    active = true;
    void Promise.resolve().then(() => entry.action({} as Lock)).then(entry.resolve, entry.reject).finally(() => { active = false; pump(); });
  }
  const request = vi.fn((name: string, options: LockOptions, action: Entry["action"]) => new Promise((resolve, reject) => {
    const entry: Entry = { action, resolve, reject, signal: options.signal, abort() {
      const index = queue.indexOf(entry);
      if (index >= 0) { queue.splice(index, 1); reject(new DOMException("Aborted", "AbortError")); }
    } };
    if (options.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    options.signal?.addEventListener("abort", entry.abort, { once: true });
    queue.push(entry); pump();
  }));
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  return request;
}
const session = { user: { id: "alice", householdId: "home", name: "Alice", email: "alice@example.com", role: "owner" }, expiresAt: null };
const response = (data: unknown = session) => new Response(JSON.stringify({ data, error: null }), { headers: { "Content-Type": "application/json" } });
const writers = {
  login: () => login({ email: "alice@example.com", password: "password" }),
  setup: () => setupOwner({ name: "Alice", email: "alice@example.com", password: "password", setupToken: "setup" }),
  password: () => changePassword({ currentPassword: "password", newPassword: "replacement" }),
};
beforeEach(() => {
  resumeHouseholdWork(); setActiveMemberId("alice");
  publishAccessBoundary("ready", { id: "alice", householdId: "home" });
  locks();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); setActiveMemberId(null); Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }); });

it.each(Object.entries(writers))("orders %s and renewal through the actual response even when the first result is ignored", async (_name, write) => {
  const held = deferred<Response>();
  const fetch = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(response({ setupRequired: false, setupAvailable: true, session }));
  vi.stubGlobal("fetch", fetch);
  const abandoned = write();
  await flush();
  const status = getAuthStatus();
  await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  held.resolve(response());
  await abandoned; await status;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].headers).toMatchObject({ "X-HomeOS-Session-Renew": "1" });
});

it.each(Object.entries(writers))("rejects queued stale %s intent before dispatch", async (_name, write) => {
  const held = deferred<Response>();
  const fetch = vi.fn().mockImplementationOnce(() => held.promise).mockImplementation(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetch);
  const status = getAuthStatus(); await flush();
  const pending = write();
  const rejected = expect(pending).rejects.toThrow("Household access changed");
  setActiveMemberId("bob"); publishAccessBoundary("ready", { id: "bob", householdId: "home" });
  held.resolve(response({ setupRequired: false, setupAvailable: true, session }));
  await status; await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects a queued password intent after a newer grant for the same member is established", async () => {
  const held = deferred<Response>();
  const fetch = vi.fn().mockImplementationOnce(() => held.promise).mockImplementation(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetch);
  const status = getAuthStatus(); await flush();
  const pending = writers.password();
  const rejected = expect(pending).rejects.toThrow("Household access changed");
  publishAccessBoundary("ready", { id: "alice", householdId: "home" });
  held.resolve(response({ setupRequired: false, setupAvailable: true, session }));
  await status; await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("allows sign-in and setup from an unchanged signed-out boundary", async () => {
  setActiveMemberId(null); publishAccessBoundary("signed-out");
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(response())); vi.stubGlobal("fetch", fetch);
  await writers.login(); await writers.setup();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("uses one fixed origin lock for all credential writers and renewals", async () => {
  const request = locks(); vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response())));
  await writers.login(); await writers.setup(); await writers.password(); await getAuthStatus();
  expect(request).toHaveBeenCalledTimes(4);
  expect(new Set(request.mock.calls.map(call => call[0])).size).toBe(1);
  expect(request.mock.calls.every(call => call[1].mode === "exclusive")).toBe(true);
});

it("keeps status observational and rejects credential writers when browser coordination is unavailable", async () => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const fetch = vi.fn().mockResolvedValue(response({ setupRequired: false, setupAvailable: true, session })); vi.stubGlobal("fetch", fetch);
  await getAuthStatus();
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("X-HomeOS-Session-Renew");
  for (const write of Object.values(writers)) await expect(write()).rejects.toMatchObject({ code: "unsupported_browser", message: "Update your browser and try again." });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("releases a failed authentication handshake so the next request can proceed", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: null, error: { code: "invalid_credentials", message: "Incorrect password." } }), { status: 401 })).mockImplementation(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetch);
  await expect(writers.login()).rejects.toMatchObject({ code: "invalid_credentials" });
  await writers.login(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("times out waiting without releasing a handshake whose response is still pending", async () => {
  vi.useFakeTimers();
  const held = deferred<Response>();
  const fetch = vi.fn().mockImplementationOnce(() => held.promise).mockImplementation(() => Promise.resolve(response())); vi.stubGlobal("fetch", fetch);
  const active = writers.login(); await flush();
  const queued = writers.setup();
  const rejected = expect(queued).rejects.toMatchObject({ code: "auth_busy" });
  await vi.advanceTimersByTimeAsync(10_000); await rejected;
  const later = writers.password(); await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  held.resolve(response()); await active; await later;
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("holds ordering through the response body and releases after a transport failure", async () => {
  const body = deferred<unknown>();
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise }).mockRejectedValueOnce(new Error("offline")).mockImplementation(() => Promise.resolve(response()));
  vi.stubGlobal("fetch", fetch);
  const first = writers.login(); await flush();
  const second = writers.setup(); const rejected = expect(second).rejects.toMatchObject({ code: "network_error" }); await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  body.resolve({ data: session, error: null }); await first; await rejected;
  await writers.login(); expect(fetch).toHaveBeenCalledTimes(3);
});
