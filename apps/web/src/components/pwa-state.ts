interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PWAState {
  canInstall: boolean;
  installed: boolean;
  ios: boolean;
  offlineReady: boolean;
  updateAvailable: boolean;
  updating: boolean;
  error: string | null;
}

const initial: PWAState = {
  canInstall: false, installed: false, ios: false, offlineReady: false,
  updateAvailable: false, updating: false, error: null,
};
let state = initial;
let installPrompt: InstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
const subscribers = new Set<() => void>();

function publish(changes: Partial<PWAState>) {
  if ((Object.keys(changes) as Array<keyof PWAState>).every((key) => state[key] === changes[key])) return;
  state = { ...state, ...changes };
  subscribers.forEach((notify) => notify());
}

export function subscribePWA(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

export function getPWAState() { return state; }
export function getServerPWAState() { return initial; }

export function initializePWA() {
  const display = window.matchMedia("(display-mode: standalone)");
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = display.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  publish({ installed, ios });
  const beforeInstall = (event: Event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    publish({ canInstall: true });
  };
  const installedEvent = () => {
    installPrompt = null;
    publish({ installed: true, canInstall: false });
  };
  const displayChange = () => publish({ installed: display.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone) });
  window.addEventListener("beforeinstallprompt", beforeInstall);
  window.addEventListener("appinstalled", installedEvent);
  display.addEventListener("change", displayChange);

  let disposed = false;
  let removeRegistrationListeners = () => {};
  const update = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void registration?.update().catch(() => {});
  };
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((result) => {
      if (disposed) return;
      registration = result;
      publish({ updateAvailable: Boolean(result.waiting), offlineReady: Boolean(result.active), error: null });
      const installers = new Set<ServiceWorker>();
      const onStateChange = () => {
        publish({
          updateAvailable: Boolean(result.waiting),
          offlineReady: Boolean(result.active) || (!navigator.serviceWorker.controller && result.installing?.state === "activated"),
        });
      };
      const watchInstalling = () => {
        if (!result.installing) return;
        installers.add(result.installing);
        result.installing.addEventListener("statechange", onStateChange);
      };
      watchInstalling();
      result.addEventListener("updatefound", watchInstalling);
      navigator.serviceWorker.addEventListener("controllerchange", onStateChange);
      removeRegistrationListeners = () => {
        result.removeEventListener("updatefound", watchInstalling);
        navigator.serviceWorker.removeEventListener("controllerchange", onStateChange);
        installers.forEach((installer) => installer.removeEventListener("statechange", onStateChange));
      };
    }).catch(() => {
      if (!disposed) publish({ error: "Offline installation could not finish. Reconnect and reopen Home OS to try again." });
    });
  }
  window.addEventListener("online", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    disposed = true;
    window.removeEventListener("beforeinstallprompt", beforeInstall);
    window.removeEventListener("appinstalled", installedEvent);
    display.removeEventListener("change", displayChange);
    window.removeEventListener("online", update);
    document.removeEventListener("visibilitychange", update);
    removeRegistrationListeners();
  };
}

export async function installPWA() {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  publish({ canInstall: false, error: null });
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") publish({ installed: true });
  } catch {
    publish({ error: "Installation did not finish. You can also install Home OS from your browser menu." });
  }
}

export function activatePWAUpdate(onActivated = () => window.location.reload()) {
  if (!registration?.waiting || state.updating) return;
  publish({ updating: true, error: null });
  const activated = () => {
    navigator.serviceWorker.removeEventListener("controllerchange", activated);
    publish({ updateAvailable: false, updating: false });
    onActivated();
  };
  navigator.serviceWorker.addEventListener("controllerchange", activated);
  registration.waiting.postMessage({ type: "HOMEOS_ACTIVATE_UPDATE" });
}
