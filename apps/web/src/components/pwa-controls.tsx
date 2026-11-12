"use client";

import { useSyncExternalStore } from "react";
import { activatePWAUpdate, getPWAState, getServerPWAState, installPWA, subscribePWA } from "./pwa-state";

export function PWAControls({ hasPendingChanges = false }: { hasPendingChanges?: boolean }) {
  const state = useSyncExternalStore(subscribePWA, getPWAState, getServerPWAState);
  return (
    <section aria-labelledby="pwa-title" className="pwa-controls">
      <h3 id="pwa-title">Home OS on this device</h3>
      <p>{state.installed ? "Installed on this device." : "Add Home OS to your home screen for quick access."}</p>
      {state.canInstall && !state.installed && <button className="button button--quiet" type="button" onClick={() => void installPWA()}>Install Home OS</button>}
      {!state.installed && !state.canInstall && <p>{state.ios ? "In Safari, tap Share, then Add to Home Screen." : "Use your browser menu to install Home OS or add it to your home screen."}</p>}
      <p role="status">{state.offlineReady ? "Ready for offline use. First sign-in and account changes need a connection." : "Open Home OS while connected to prepare it for offline use."}</p>
      {state.updateAvailable && <div>
        <p>A Home OS update is ready.{hasPendingChanges ? " Sync your pending changes before updating." : " Reload when you have finished any open forms."}</p>
        <button className="button button--quiet" type="button" disabled={hasPendingChanges || state.updating} onClick={() => activatePWAUpdate()}>{state.updating ? "Updating…" : "Update and reload"}</button>
      </div>}
      {state.error && <p role="alert">{state.error}</p>}
    </section>
  );
}
