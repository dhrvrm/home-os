"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthScreen } from "@/components/auth-screen";
import { InventoryApp } from "@/components/inventory-app";
import { APIError } from "@/lib/api";
import { getAuthStatus, logout, type AuthSession, type AuthStatus } from "@/lib/auth";
import { clearInventoryCache, loadInventoryCache } from "@/lib/inventory-cache";
import { homeOSDatabase } from "@/offline/db";
import { clearDataOwner, clearSavedSession, readDataOwner, readSavedSession, saveSession, setDataOwner } from "./session";
import { ACCESS_BOUNDARY_KEY, boundaryMember, boundaryState, captureAccessProof, drainHouseholdWork, isCurrentAccessProof, lockHouseholdWork, publishAccessBoundary, readAccessBoundary, resumeHouseholdWork, setActiveMemberId, type AccessProof } from "./work";
import "@/components/auth.css";

type GateState =
  | { kind: "checking" }
  | { kind: "ready"; session: AuthSession }
  | { kind: "login"; setupRequired: boolean; setupAvailable: boolean; message?: string }
  | { kind: "error"; message: string };

class AccountSwitchRequired extends Error {}

async function clearHouseholdState(): Promise<void> {
  await homeOSDatabase.transaction("rw", homeOSDatabase.tables, async () => {
    await Promise.all(homeOSDatabase.tables.map((table) => table.clear()));
  });
  clearInventoryCache();
}

function transportFailure(error: unknown): boolean {
  return (error instanceof APIError && ["network_error", "offline", "timeout"].includes(error.code)) || error instanceof TypeError;
}

export function AuthGate() {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const sequence = useRef(0);
  const sessionRef = useRef<AuthSession | null>(null);
  const transition = useRef(false);
  const mounted = useRef(false);

  const showLogin = useCallback((message?: string, setupRequired = false, setupAvailable = true) => {
    sessionRef.current = null;
    setState({ kind: "login", setupRequired, setupAvailable, message });
  }, []);

  const admitSession = useCallback(async (session: AuthSession, interactive: boolean, ticket: number, expectedBoundary?: string | null) => {
    if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error("This sign-in has expired. Sign in again to continue.");
    }
    lockHouseholdWork();
    await drainHouseholdWork();
    if (!mounted.current || ticket !== sequence.current) return;
    const checkBoundary = () => {
      if (expectedBoundary !== undefined && expectedBoundary !== readAccessBoundary()) {
        throw new AccountSwitchRequired("Sign-in changed in another tab. Reopen Home OS to use its current account.");
      }
    };
    checkBoundary();
    const previous = readDataOwner();
    const unknownData = !previous && ((loadInventoryCache()?.items.length ?? 0) > 0 || (await Promise.all(homeOSDatabase.tables.map((table) => table.count()))).some((count) => count > 0));
    const switching = previous
      ? previous.id !== session.user.id || previous.householdId !== session.user.householdId
      // Only the original seeded owner may adopt the pre-authentication cache.
      : session.user.id !== "local-owner" && unknownData;
    checkBoundary();

    if (switching) {
      const queued = await homeOSDatabase.outbox.count();
      if (queued > 0) {
        if (!interactive) throw new AccountSwitchRequired("Saved changes belong to another member. Sign in as that member to sync them, or sign in with another account and explicitly discard them.");
        if (!window.confirm("This device has unsynced changes from another member. Switching accounts will discard those changes and remove their saved household data. Switch accounts?")) {
          await logout();
          clearSavedSession();
          publishAccessBoundary("locked");
          showLogin("Account switch cancelled. Sign in as the original member to keep and synchronize their saved changes.");
          throw new Error("Account switch cancelled. Your original member’s saved changes were kept.");
        }
      }
      checkBoundary();
      publishAccessBoundary("locked");
      // Continue checking the boundary published for this clearing operation.
      expectedBoundary = readAccessBoundary();
      await clearHouseholdState();
    }
    if (!mounted.current || ticket !== sequence.current) return;
    // A browser close during a previous request must not strand an outbox row.
    await homeOSDatabase.outbox.where("state").equals("sending").modify({ state: "pending" });
    if (!mounted.current || ticket !== sequence.current) return;
    checkBoundary();
    setDataOwner(session.user);
    saveSession(session);
    if (interactive || boundaryState() !== "ready") publishAccessBoundary("ready", session.user);
    setActiveMemberId(session.user.id);
    resumeHouseholdWork();
    sessionRef.current = session;
    setState({ kind: "ready", session });
  }, [showLogin]);

  const verifyAccess = useCallback(async () => {
    if (transition.current) return;
    const ticket = ++sequence.current;
    const current = sessionRef.current;
    const sharedMember = boundaryMember();
    const background = !!current && Date.parse(current.expiresAt) > Date.now() && boundaryState() === "ready"
      && (!sharedMember || (sharedMember.id === current.user.id && sharedMember.householdId === current.user.householdId));
    if (!background) {
      lockHouseholdWork();
      setState({ kind: "checking" });
    }
    try {
      let status: AuthStatus | null = null;
      let acceptedBoundary: string | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = readAccessBoundary();
        const candidate = await getAuthStatus();
        if (!mounted.current || ticket !== sequence.current) return;
        if (before === readAccessBoundary()) {
          status = candidate;
          acceptedBoundary = before;
          break;
        }
        const readyMember = boundaryMember();
        if (!current || !readyMember || readyMember.id !== current.user.id || readyMember.householdId !== current.user.householdId) {
          lockHouseholdWork();
          setState({ kind: "checking" });
        }
      }
      if (!status) throw new AccountSwitchRequired("Sign-in keeps changing in another tab. Reopen Home OS to retry.");
      if (status.session) {
        if (background && current.user.id === status.session.user.id && current.user.householdId === status.session.user.householdId
          && current.user.role === status.session.user.role && Date.parse(status.session.expiresAt) > Date.now() && boundaryState() === "ready" && readAccessBoundary() === acceptedBoundary) {
          // Rechecking a valid same-member session must not unmount open forms
          // or invalidate inventory work already admitted for that member.
          saveSession(status.session);
          setActiveMemberId(status.session.user.id);
          sessionRef.current = status.session;
          setState({ kind: "ready", session: status.session });
        } else {
          lockHouseholdWork();
          setState({ kind: "checking" });
          await admitSession(status.session, false, ticket, acceptedBoundary);
        }
      }
      else {
        lockHouseholdWork();
        const hadAccess = !!readSavedSession() || !!readDataOwner();
        clearSavedSession();
        if (hadAccess && !["locked", "signed-out"].includes(boundaryState() ?? "")) publishAccessBoundary("locked");
        showLogin(hadAccess ? "Sign in again to continue. Your unsynced changes are kept for the same member." : undefined, status.setupRequired, status.setupAvailable);
      }
    } catch (error) {
      if (!mounted.current || ticket !== sequence.current) return;
      if (error instanceof AccountSwitchRequired) { lockHouseholdWork(); showLogin(error.message); return; }
      const saved = transportFailure(error) && boundaryState() !== "locked" && boundaryState() !== "signed-out" ? readSavedSession() : null;
      const owner = readDataOwner();
      if (saved && owner?.id === saved.user.id && owner.householdId === saved.user.householdId) {
        setActiveMemberId(saved.user.id);
        if (!background || current.user.id !== saved.user.id || current.user.householdId !== saved.user.householdId || current.user.role !== saved.user.role) resumeHouseholdWork();
        sessionRef.current = saved;
        setState({ kind: "ready", session: saved });
      } else {
        lockHouseholdWork();
        sessionRef.current = null;
        setState({ kind: "error", message: transportFailure(error)
          ? "Connect to the internet to sign in. An unexpired saved sign-in is required to open Home OS offline."
          : error instanceof Error ? error.message : "Home OS could not check your sign-in. Try again." });
      }
    }
  }, [admitSession, showLogin]);

  const expireAccess = useCallback((event?: Event) => {
    if (event instanceof CustomEvent && (!event.detail || !isCurrentAccessProof(event.detail as AccessProof))) return;
    sequence.current++;
    lockHouseholdWork();
    clearSavedSession();
    publishAccessBoundary("locked");
    showLogin("Your session has ended. Sign in again to continue. Your saved changes are kept for the same member.");
  }, [showLogin]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => { if (active) void verifyAccess(); });
    const online = () => { void verifyAccess(); };
    const visible = () => { if (document.visibilityState === "visible" && navigator.onLine) void verifyAccess(); };
    const changedElsewhere = (event: StorageEvent) => {
      if (event.key !== ACCESS_BOUNDARY_KEY) return;
      const readyMember = boundaryMember();
      const current = sessionRef.current;
      if (readyMember && current?.user.id === readyMember.id && current.user.householdId === readyMember.householdId) {
        void verifyAccess();
        return;
      }
      sequence.current++;
      lockHouseholdWork();
      if (boundaryState() === "ready") {
        // Hide the old account before checking the shared cookie's new owner.
        sessionRef.current = null;
        setState({ kind: "checking" });
        void verifyAccess();
      } else {
        clearSavedSession();
        showLogin("Access changed in another tab. Sign in again to continue.");
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("home-os:session-expired", expireAccess);
    window.addEventListener("storage", changedElsewhere);
    return () => {
      active = false;
      mounted.current = false;
      // This ref is an intentional invalidation counter, not an effect resource.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      lockHouseholdWork();
      window.removeEventListener("online", online);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("home-os:session-expired", expireAccess);
      window.removeEventListener("storage", changedElsewhere);
    };
  }, [expireAccess, showLogin, verifyAccess]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const proof = captureAccessProof();
    const remaining = Date.parse(state.session.expiresAt) - Date.now();
    const timeout = window.setTimeout(() => {
      if (sessionRef.current !== state.session) return;
      if (Date.parse(state.session.expiresAt) <= Date.now() && isCurrentAccessProof(proof)) expireAccess();
      else void verifyAccess();
    }, Math.min(Math.max(remaining, 0), 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [state, expireAccess, verifyAccess]);

  const authenticated = useCallback(async (session: AuthSession) => {
    transition.current = true;
    const ticket = ++sequence.current;
    try { await admitSession(session, true, ticket); }
    finally { transition.current = false; }
  }, [admitSession]);

  const signOut = useCallback(async () => {
    if (navigator.onLine === false) throw new Error("Connect to the internet to sign out and revoke this device’s session.");
    const previous = sessionRef.current;
    if (!previous) return;
    transition.current = true;
    sequence.current++;
    const boundaryBefore = readAccessBoundary();
    lockHouseholdWork();
    let revoked = false;
    try {
      await drainHouseholdWork();
      const queued = await homeOSDatabase.outbox.count();
      if (queued > 0 && !window.confirm("You have unsynced changes on this device. Signing out will discard them. Sign out anyway?")) {
        throw new Error("Sign-out cancelled. Sync your changes before signing out to keep them.");
      }
      await logout();
      revoked = true;
      if (!mounted.current) return;
      publishAccessBoundary("locked");
      setState({ kind: "checking" });
      await clearHouseholdState();
      clearSavedSession();
      clearDataOwner();
      publishAccessBoundary("signed-out");
      showLogin("You are signed out. Saved household data was removed from this device.");
    } catch (error) {
      if (revoked) {
        clearSavedSession();
        publishAccessBoundary("signed-out");
        sessionRef.current = null;
        setState({ kind: "error", message: "You are signed out, but saved device data could not be cleared. Close other Home OS tabs and retry before sharing this device." });
        throw error;
      }
      if (readAccessBoundary() === boundaryBefore) {
        saveSession(previous);
        setActiveMemberId(previous.user.id);
        resumeHouseholdWork();
        sessionRef.current = previous;
        setState({ kind: "ready", session: previous });
      } else {
        sessionRef.current = null;
        setState({ kind: "checking" });
        queueMicrotask(() => { void verifyAccess(); });
      }
      throw error;
    } finally { transition.current = false; }
  }, [showLogin, verifyAccess]);

  if (state.kind === "ready") {
    return <InventoryApp key={`${state.session.user.householdId}:${state.session.user.id}:${state.session.user.role}`} session={state.session} onLogout={signOut} onSessionChange={(session) => {
      void authenticated(session).catch((error) => setState({ kind: "error", message: error instanceof Error ? error.message : "Sign in again to continue." }));
    }} />;
  }
  if (state.kind === "login") return <AuthScreen setupRequired={state.setupRequired} setupAvailable={state.setupAvailable} message={state.message} onAuthenticated={authenticated} />;
  return <main className="auth-page"><section className="auth-card" aria-labelledby="access-title"><h1 id="access-title">Home OS</h1>{state.kind === "checking"
    ? <p role="status">Checking your sign-in…</p>
    : <><p role="alert">{state.message}</p><button className="button button--primary" type="button" onClick={() => void verifyAccess()}>Retry connection</button></>}
  </section></main>;
}
