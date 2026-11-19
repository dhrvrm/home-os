"use client";
import { useCallback, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkLease } from "@/auth/work";
import { requireIdentity } from "@/household/api";
import type { AuthUser } from "@/lib/auth";
import type { AcceptedReference } from "./types";

interface MoneyLifetime {
  publishAccepted(lease: WorkLease, operationId: string, reference: AcceptedReference): void;
  setGuard(editor: symbol, guarded: boolean): void;
}
const MoneyLifetimeContext = createContext<MoneyLifetime | null>(null);
const MoneyReadSignalContext = createContext<symbol | null>(null);

interface MoneyCallbacks { onReadInvalidated: () => void; onRecorded: (reference: AcceptedReference, operationId?: string) => void; onGuardChange: (guarded: boolean) => void }
interface OwnerIdentity { id: string | undefined; householdId: string | undefined; role: AuthUser["role"] | undefined }
/** Mutable capability lifetime belongs to this controller, outside React render. */
function createMoneyOwner(identity: OwnerIdentity) {
  let alive = false;
  let currentUser: AuthUser | undefined;
  let callbacks: MoneyCallbacks | undefined;
  const guards = new Set<symbol>();
  const published = new Set<string>();
  const liveUser = () => {
    const user = currentUser;
    return alive && user && user.id === identity.id && user.householdId === identity.householdId && user.role === identity.role ? user : undefined;
  };
  const capability: MoneyLifetime = {
    publishAccepted(lease, operationId, reference) {
      const user = liveUser();
      if (!user) return;
      requireIdentity(user, lease);
      if (published.has(operationId)) return;
      published.add(operationId);
      // This bounds announcement deduplication; server receipts remain authoritative.
      if (published.size > 128) { const oldest = published.values().next().value; if (oldest !== undefined) published.delete(oldest); }
      callbacks?.onReadInvalidated();
      callbacks?.onRecorded(reference, operationId);
    },
    setGuard(editor, guarded) {
      if (!liveUser()) return;
      if (guarded) guards.add(editor); else guards.delete(editor);
      callbacks?.onGuardChange(guards.size > 0);
    },
  };
  return { capability, update(user: AuthUser | undefined, nextCallbacks: MoneyCallbacks) { currentUser = user; callbacks = nextCallbacks; }, activate() { alive = true; }, invalidate() { alive = false; guards.clear(); published.clear(); callbacks?.onGuardChange(false); } };
}

/** The application owns acceptance and the union of its mounted editors' guards. */
export function MoneyLifetimeProvider({ user, onRecorded, onGuardChange, children }: { user: AuthUser | undefined; onRecorded: (reference: AcceptedReference, operationId?: string) => void; onGuardChange: (guarded: boolean) => void; children: ReactNode }) {
  const id = user?.id; const householdId = user?.householdId; const role = user?.role;
  const owner = useMemo(() => createMoneyOwner({ id, householdId, role }), [id, householdId, role]);
  const [readSignal, setReadSignal] = useState(() => Symbol("money-read"));
  useLayoutEffect(() => { owner.update(user, { onRecorded, onGuardChange, onReadInvalidated: () => setReadSignal(Symbol("money-read")) }); }, [owner, user, onRecorded, onGuardChange]);
  useLayoutEffect(() => { owner.activate(); return () => owner.invalidate(); }, [owner]);
  return <MoneyLifetimeContext.Provider value={owner.capability}><MoneyReadSignalContext.Provider value={readSignal}>{children}</MoneyReadSignalContext.Provider></MoneyLifetimeContext.Provider>;
}
export function useMoneyLifetime(): MoneyLifetime | null { return useContext(MoneyLifetimeContext); }
/** Only verified, current-owner acceptance invalidates mounted financial reads. */
export function useMoneyReadSignal(): symbol | null { return useContext(MoneyReadSignalContext); }

/** Each editor releases only its own opaque registration. */
export function useMoneyGuard(guarded: boolean, onDirtyChange?: (guarded: boolean) => void): () => void {
  const lifetime = useMoneyLifetime();
  const editor = useRef(Symbol("money-editor"));
  const fallback = useRef(onDirtyChange);
  useLayoutEffect(() => { fallback.current = onDirtyChange; }, [onDirtyChange]);
  const release = useCallback(() => {
    if (lifetime) lifetime.setGuard(editor.current, false);
    else fallback.current?.(false);
  }, [lifetime]);
  useEffect(() => {
    if (lifetime) lifetime.setGuard(editor.current, guarded);
    else onDirtyChange?.(guarded);
  }, [lifetime, guarded, onDirtyChange]);
  useEffect(() => {
    const token = editor.current;
    return () => { if (lifetime) lifetime.setGuard(token, false); else onDirtyChange?.(false); };
  }, [lifetime, onDirtyChange]);
  return release;
}
