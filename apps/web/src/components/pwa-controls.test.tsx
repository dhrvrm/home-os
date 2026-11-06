import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("PWA device controls", () => {
  let initializePWA: typeof import("./pwa-state").initializePWA;
  let getPWAState: typeof import("./pwa-state").getPWAState;
  let activatePWAUpdate: typeof import("./pwa-state").activatePWAUpdate;
  let PWAControls: typeof import("./pwa-controls").PWAControls;
  let remove: (() => void) | undefined;
  let registration: EventTarget & { active: object | null; waiting: { postMessage: ReturnType<typeof vi.fn> } | null; installing: null; update: ReturnType<typeof vi.fn> };
  let serviceWorker: EventTarget & { register: ReturnType<typeof vi.fn>; controller: null };

  beforeEach(async () => {
    vi.resetModules();
    const display = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", vi.fn(() => display));
    registration = Object.assign(new EventTarget(), { active: {}, waiting: null, installing: null, update: vi.fn().mockResolvedValue(undefined) });
    serviceWorker = Object.assign(new EventTarget(), { register: vi.fn().mockResolvedValue(registration), controller: null });
    vi.stubGlobal("navigator", { serviceWorker, userAgent: "test", platform: "test", maxTouchPoints: 0, onLine: true });
    ({ initializePWA, getPWAState, activatePWAUpdate } = await import("./pwa-state"));
    ({ PWAControls } = await import("./pwa-controls"));
  });

  afterEach(() => {
    cleanup();
    remove?.();
    remove = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers a browser install prompt only after the browser supplies one", async () => {
    remove = initializePWA();
    await act(async () => { render(<PWAControls />); });
    expect(screen.queryByRole("button", { name: "Install Home OS" })).not.toBeInTheDocument();
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt, userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Install Home OS" }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(screen.getByText("Installed on this device.")).toBeInTheDocument();
  });

  it("keeps the current app running when an update is waiting and blocks reload with queued changes", async () => {
    registration.waiting = { postMessage: vi.fn() };
    remove = initializePWA();
    await act(async () => { render(<PWAControls hasPendingChanges />); });
    expect(screen.getByRole("button", { name: "Update and reload" })).toBeDisabled();
    expect(registration.waiting.postMessage).not.toHaveBeenCalled();
    expect(screen.getByText(/Sync your pending changes/)).toBeInTheDocument();
  });

  it("activates and reloads only after the member explicitly requests an update", async () => {
    registration.waiting = { postMessage: vi.fn() };
    remove = initializePWA();
    await waitFor(() => expect(getPWAState().updateAvailable).toBe(true));
    const reload = vi.fn();
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
    activatePWAUpdate(reload);
    expect(registration.waiting.postMessage).toHaveBeenCalledWith({ type: "HOMEOS_ACTIVATE_UPDATE" });
    expect(reload).not.toHaveBeenCalled();
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports a failed worker registration without an unhandled promise rejection", async () => {
    serviceWorker.register.mockRejectedValueOnce(new Error("offline"));
    remove = initializePWA();
    await act(async () => { render(<PWAControls />); });
    expect(screen.getByRole("alert")).toHaveTextContent("Offline installation could not finish");
    expect(getPWAState().offlineReady).toBe(false);
  });

  it("explains Add to Home Screen on iOS when a direct install prompt is unavailable", async () => {
    vi.stubGlobal("navigator", { serviceWorker, userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5, onLine: true });
    remove = initializePWA();
    await act(async () => { render(<PWAControls />); });
    expect(screen.getByText("In Safari, tap Share, then Add to Home Screen.")).toBeInTheDocument();
  });
});
