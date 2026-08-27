"use client";

import { useCallback, useEffect, useState } from "react";
import { Gear, SignOut, UserCircle } from "@phosphor-icons/react";
import { authClient, loadHomeSession, postAuth, type HomeSessionContext } from "@/lib/auth-client";
import { InventoryApp } from "./inventory-app";
import { OrganizationOnboarding } from "./organization-onboarding";
import { OrganizationSettings } from "./organization-settings";
import { SignInScreen } from "./sign-in-screen";

export function AuthGate() {
  const [session, setSession] = useState<HomeSessionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await loadHomeSession());
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Home OS could not load your account.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadHomeSession()
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (!active) return;
        setError(problem instanceof Error ? problem.message : "Home OS could not load your account.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  if (loading) return <main className="auth-page"><div className="auth-loading" role="status">Opening Home OS…</div></main>;
  if (error) return <main className="auth-page"><section className="auth-card"><h1>Home OS could not open</h1><p className="auth-copy">{error}</p><button className="button button--primary" onClick={() => { setLoading(true); void refresh(); }}>Try again</button></section></main>;
  if (!session?.authenticated) return <SignInScreen />;
  if (!session.activeOrganization || !session.household || !session.membership) {
    return <OrganizationOnboarding session={session} onReady={refresh} />;
  }

  async function switchHome(organizationId: string) {
    await postAuth("/api/auth/organization/set-active", { organizationId });
    setSettings(false);
    setLoading(true);
    await refresh();
  }

  async function signOut() {
    await authClient.signOut();
    setSettings(false);
    setSession({ authenticated: false });
  }

  return <div className="authenticated-shell">
    <div className="account-dock" aria-label="Account and home controls">
      <select aria-label="Active home" value={session.activeOrganization.id} onChange={(event) => void switchHome(event.target.value)}>
        {(session.organizations ?? []).map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
      </select>
      <button className={settings ? "icon-button is-active" : "icon-button"} aria-label="Home settings" onClick={() => setSettings((value) => !value)}><Gear size={18} /></button>
      <span className="account-dock__user"><UserCircle size={20} /><span>{session.user?.name}</span></span>
      <button className="icon-button" aria-label="Sign out" onClick={() => void signOut()}><SignOut size={18} /></button>
    </div>
    {settings
      ? <OrganizationSettings session={session} onBack={() => setSettings(false)} />
      : <InventoryApp householdId={session.household.id} actorId={session.membership.id} homeName={session.activeOrganization.name} />}
  </div>;
}
