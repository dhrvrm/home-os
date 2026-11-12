"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { X } from "@phosphor-icons/react";
import {
  AccessChangedError,
  runHouseholdWork,
  type WorkLease,
} from "@/auth/work";
import type { AuthUser } from "@/lib/auth";
import { errorMessage, householdRead, online, requireIdentity } from "./api";
import type { SavedCopy } from "./cache";
export function useOnline(): boolean {
  const [connected, setConnected] = useState(online);
  useEffect(() => {
    const update = () => setConnected(online());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return connected;
}
export function useHouseholdTask(user: AuthUser) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    async <T,>(
      action: (lease: WorkLease) => Promise<T>,
      accept: (value: T) => void,
      reject: (error: unknown) => void,
    ) => {
      await runHouseholdWork(async (lease) => {
        requireIdentity(user, lease);
        try {
          const result = await action(lease);
          requireIdentity(user, lease);
          if (mounted.current) accept(result);
        } catch (error) {
          requireIdentity(user, lease);
          if (mounted.current && !(error instanceof AccessChangedError))
            reject(error);
        }
      }).catch((error) => {
        if (!(error instanceof AccessChangedError) && mounted.current)
          reject(error);
      });
    },
    [user],
  );
}
export interface HouseholdResource<T> {
  copy?: SavedCopy<T>;
  error?: string;
  loading: boolean;
  refresh: () => Promise<void>;
}
export function useResource<T>(
  user: AuthUser,
  domain: string,
  path: string,
  valid: (data: unknown) => data is T,
): HouseholdResource<T> {
  const identity = `${user.householdId}:${user.id}:${user.role}:${domain}`;
  const [state, setState] = useState<{
    identity: string;
    copy?: SavedCopy<T>;
    error?: string;
    loading: boolean;
  }>({ identity, loading: true });
  const task = useHouseholdTask(user);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    setState((old) => ({
      identity,
      ...(old.identity === identity ? { copy: old.copy } : {}),
      loading: true,
    }));
    await task(
      () => householdRead(user, domain, path, valid),
      (copy) => {
        if (request === sequence.current)
          setState({ identity, copy, loading: false });
      },
      (error) => {
        if (request === sequence.current)
          setState((old) => ({
            ...old,
            identity,
            loading: false,
            error: errorMessage(error),
          }));
      },
    );
  }, [task, user, domain, path, valid, identity]);
  // A mutation can finish after the user changes filters. Its refresh must
  // revalidate the current query instead of resurrecting the closed-over query.
  const currentRefresh = useRef<(() => Promise<void>) | null>(null);
  useLayoutEffect(() => {
    currentRefresh.current = refresh;
    return () => { currentRefresh.current = null; };
  }, [refresh]);
  const refreshCurrent = useCallback(() => currentRefresh.current?.() ?? Promise.resolve(), []);
  useEffect(() => {
    let active = true;
    const requests = sequence;
    void Promise.resolve().then(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
      requests.current++;
    };
  }, [refresh]);
  return {
    ...(state.identity === identity ? state : { loading: true }),
    refresh: refreshCurrent,
  };
}
export function ResourceState({
  loading,
  error,
  copy,
  retry,
}: {
  loading: boolean;
  error?: string;
  copy?: SavedCopy<unknown>;
  retry: () => void;
}) {
  return (
    <>
      {loading && <p role="status">Loading household information…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}{" "}
          <button className="button button--quiet" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      {copy?.cached && (
        <p className="hh-notice" role="status">
          Saved copy · {new Date(copy.savedAt).toLocaleString()}. Connect to
          check for changes.
        </p>
      )}
    </>
  );
}
export function WriteReason({
  user,
  connected,
}: {
  user: AuthUser;
  connected: boolean;
}) {
  return user.role === "viewer" ? (
    <p className="hh-muted">Viewers can read shared plans and contacts.</p>
  ) : !connected ? (
    <p className="hh-notice">
      You’re offline. Connect to save changes; your open draft is kept.
    </p>
  ) : null;
}
export function Modal({
  title,
  pending,
  onClose,
  children,
}: {
  title: string;
  pending: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(
    typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>("input, textarea, select, button")
      ?.focus();
    const target = returnTo.current;
    return () => target?.focus();
  }, []);
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onClose();
    }
    if (event.key !== "Tab") return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]',
      ) ?? [],
    );
    if (!items.length) {
      event.preventDefault();
      ref.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    }
    if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  }
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className="dialog hh-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onKeyDown={keys}
      >
        <header className="dialog__header">
          <h2 id={id}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close editor"
            disabled={pending}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field${wide ? " field--wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function SaveActions({
  pending,
  disabled,
  onClose,
  label = "Save",
}: {
  pending: boolean;
  disabled?: boolean;
  onClose: () => void;
  label?: string;
}) {
  return (
    <footer className="dialog__actions field--wide">
      <button
        type="button"
        className="button button--quiet"
        disabled={pending}
        onClick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        className="button button--primary"
        disabled={pending || disabled}
      >
        {pending ? "Saving…" : label}
      </button>
    </footer>
  );
}
export function labelsFrom(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
