"use client";

import { useEffect, useState, type FormEvent } from "react";
import { changePassword, type AuthSession } from "@/lib/auth";
import { errorMessage, PasswordField } from "./auth-fields";
import { PWAControls } from "./pwa-controls";
import "./auth.css";

interface AccountPanelProps {
  session: AuthSession;
  onLogout: () => Promise<void>;
  onSessionChange: (session: AuthSession) => void;
  hasPendingChanges?: boolean;
}

export function AccountPanel({ session, onLogout, onSessionChange, hasPendingChanges = false }: AccountPanelProps) {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [pending, setPending] = useState<"password" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine);
    refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, []);

  async function signOut() {
    setPending("logout");
    setError(null);
    setSuccess(null);
    try { await onLogout(); }
    catch (failure) { setError(errorMessage(failure, "Sign out could not be completed. Try again.")); }
    finally { setPending(null); }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const newPassword = String(values.get("newPassword") ?? "");
    setSuccess(null);
    if (newPassword !== values.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setPending("password");
    try {
      const refreshed = await changePassword({ currentPassword: String(values.get("currentPassword") ?? ""), newPassword });
      onSessionChange(refreshed);
      setPasswordOpen(false);
      setSuccess("Password changed. Other signed-in sessions have been ended.");
    } catch (failure) {
      setError(errorMessage(failure, "Your password could not be changed. Try again."));
    } finally { setPending(null); }
  }

  return (
    <section className="account-panel" aria-label="Your account">
      <div className="account-section">
        <header className="account-heading">
          <div><h2>{session.user.name}</h2><p>{session.user.email} · {session.user.role === "owner" ? "Household owner" : session.user.role === "viewer" ? "View-only member" : "Household member"}</p></div>
          <button type="button" className="button button--quiet" onClick={() => void signOut()} disabled={pending !== null || !online}>{pending === "logout" ? "Signing out…" : "Sign out"}</button>
        </header>
        {!online && <p className="account-offline" role="status">You’re offline. Connect to change your password or sign out of this session.</p>}
        {hasPendingChanges && <p className="account-description" style={{ marginTop: 16 }}>You have changes saved on this device. Sync them before signing out.</p>}
        {error && <p className="form-error" role="alert" style={{ marginTop: 16 }}>{error}</p>}
        {success && <p className="account-success" role="status" style={{ marginTop: 16 }}>{success}</p>}
      </div>
      <div className="account-section">
        <h3>Your password</h3>
        <p className="account-description">Use a password you do not use elsewhere. Your browser’s password manager can save it for you.</p>
        {!passwordOpen
          ? <button type="button" className="button button--quiet" style={{ marginTop: 18 }} disabled={pending !== null || !online} onClick={() => { setPasswordOpen(true); setError(null); setSuccess(null); }}>Change password</button>
          : <form className="account-form" onSubmit={submitPassword} aria-busy={pending === "password"}>
            <input className="sr-only" type="email" name="username" autoComplete="username" value={session.user.email} readOnly tabIndex={-1} aria-hidden="true" />
            <PasswordField label="Current password" name="currentPassword" autoComplete="current-password" disabled={pending !== null} />
            <PasswordField label="New password" name="newPassword" autoComplete="new-password" disabled={pending !== null} help="Use 12–128 characters. Other sessions will be signed out." />
            <PasswordField label="Confirm new password" name="confirmPassword" autoComplete="new-password" disabled={pending !== null} />
            <div className="account-form__actions">
              <button type="submit" className="button button--primary" disabled={pending !== null || !online}>{pending === "password" ? "Saving…" : "Save password"}</button>
              <button type="button" className="button button--quiet" disabled={pending !== null} onClick={() => { setPasswordOpen(false); setError(null); }}>Cancel</button>
            </div>
          </form>}
      </div>
      <div className="account-section"><PWAControls hasPendingChanges={hasPendingChanges} /></div>
    </section>
  );
}
