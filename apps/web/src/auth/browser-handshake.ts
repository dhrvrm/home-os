import { APIError } from "@/lib/api";
import { AccessChangedError, captureAccessProof, isCurrentAccessProof } from "./work";

const HANDSHAKE_LOCK = "home-os:browser-auth-handshake:v1";
const ACQUISITION_TIMEOUT_MS = 10_000;

export function canCoordinateBrowserAuth(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

// Every request that may install a session cookie shares this origin-wide lock.
// Keep its lifetime tied to the request, even if the calling view is abandoned.
export async function withBrowserAuthHandshake<T>(action: () => Promise<T>, requireCurrentAccess = true): Promise<T> {
  if (!canCoordinateBrowserAuth()) throw new APIError("Update your browser and try again.", "unsupported_browser");
  const proof = captureAccessProof();
  const waiting = new AbortController();
  const timeout = window.setTimeout(() => waiting.abort(), ACQUISITION_TIMEOUT_MS);
  try {
    return await navigator.locks.request(HANDSHAKE_LOCK, { mode: "exclusive", signal: waiting.signal }, async () => {
      // Acquisition has finished. A queue timeout must never release an active
      // request whose cookie-affecting response is still on its way.
      window.clearTimeout(timeout);
      if (requireCurrentAccess && !isCurrentAccessProof(proof)) throw new AccessChangedError();
      return await action();
    });
  } catch (error) {
    if (waiting.signal.aborted) throw new APIError("Another sign-in is still finishing. Wait a moment and try again.", "auth_busy");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
