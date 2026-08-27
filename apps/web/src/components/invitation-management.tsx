"use client";

import { useState, type FormEvent } from "react";
import { Copy, Trash } from "@phosphor-icons/react";
import { postAuth, type FullOrganization } from "@/lib/auth-client";

export function InvitationManagement({ organization, canManage, onChanged }: {
  organization: FullOrganization;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [error, setError] = useState<string | null>(null);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await postAuth("/api/auth/organization/invite-member", { email, role, organizationId: organization.id });
      setEmail("");
      await onChanged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The invitation could not be created.");
    }
  }

  async function cancel(invitationId: string) {
    await postAuth("/api/auth/organization/cancel-invitation", { invitationId });
    await onChanged();
  }

  function invitationURL(invitationId: string) {
    return `${window.location.origin}/invite?id=${encodeURIComponent(invitationId)}`;
  }

  return <section className="settings-section" aria-labelledby="invitations-title">
    <header><div><p>Join links</p><h2 id="invitations-title">Invitations</h2></div><span>{organization.invitations.length}</span></header>
    {canManage && <form className="settings-inline-form" onSubmit={(event) => void invite(event)}>
      <input type="email" required placeholder="roommate@example.com" aria-label="Invitee email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <select aria-label="Invitation role" value={role} onChange={(event) => setRole(event.target.value)}><option value="member">Member</option><option value="admin">Admin</option></select>
      <button className="button button--primary">Create invite</button>
    </form>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="settings-note">Home OS creates a secure invitation link. Email delivery is not configured yet, so copy and send the link yourself.</p>
    <div className="settings-list">
      {organization.invitations.length === 0 && <p className="settings-empty">No pending invitations.</p>}
      {organization.invitations.map((invitation) => <article key={invitation.id}>
        <div><strong>{invitation.email}</strong><small>{invitation.role} · {invitation.status}</small></div>
        <button className="button button--small button--quiet" onClick={() => void navigator.clipboard.writeText(invitationURL(invitation.id))}><Copy size={15} />Copy link</button>
        {canManage && <button className="icon-button icon-button--small" aria-label={`Cancel invitation for ${invitation.email}`} onClick={() => void cancel(invitation.id)}><Trash size={16} /></button>}
      </article>)}
    </div>
  </section>;
}
