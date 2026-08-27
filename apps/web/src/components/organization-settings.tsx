"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, House, ShieldCheck } from "@phosphor-icons/react";
import { loadFullOrganization, type FullOrganization, type HomeSessionContext } from "@/lib/auth-client";
import { GroupManagement } from "./group-management";
import { InvitationManagement } from "./invitation-management";
import { MemberManagement } from "./member-management";

export function OrganizationSettings({ session, onBack }: {
  session: HomeSessionContext;
  onBack: () => void;
}) {
  const [organization, setOrganization] = useState<FullOrganization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const organizationId = session.activeOrganization!.id;
  const canManage = session.membership?.role === "owner" || session.membership?.role === "admin";

  const refresh = useCallback(async () => {
    try {
      setOrganization(await loadFullOrganization(organizationId));
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Home settings could not be loaded.");
    }
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    void loadFullOrganization(organizationId)
      .then((nextOrganization) => {
        if (!active) return;
        setOrganization(nextOrganization);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (!active) return;
        setError(problem instanceof Error ? problem.message : "Home settings could not be loaded.");
      });
    return () => { active = false; };
  }, [organizationId]);

  return <main className="settings-page">
    <header className="settings-page__header">
      <button className="button button--quiet" onClick={onBack}><ArrowLeft size={17} />Inventory</button>
      <div><p>Home settings</p><h1>{session.activeOrganization?.name}</h1></div>
      <span className="role-pill"><ShieldCheck size={14} />{session.membership?.role}</span>
    </header>
    {!canManage && <div className="settings-permission-note"><House size={19} /><p><strong>You are a member of this home.</strong><span>Owners and admins manage roles, groups, and invitations.</span></p></div>}
    {error && <div className="error-state" role="alert"><p>{error}</p><button className="button button--quiet" onClick={() => void refresh()}>Try again</button></div>}
    {!organization && !error && <div className="loading-state"><p>Loading home settings</p></div>}
    {organization && <div className="settings-grid">
      <MemberManagement organization={organization} currentUserId={session.user!.id} canManage={canManage} onChanged={refresh} />
      <InvitationManagement organization={organization} canManage={canManage} onChanged={refresh} />
      <GroupManagement organization={organization} canManage={canManage} onChanged={refresh} />
    </div>}
  </main>;
}
