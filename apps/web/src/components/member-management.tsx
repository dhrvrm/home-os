"use client";

import { Trash, UserCircle } from "@phosphor-icons/react";
import { postAuth, type FullOrganization } from "@/lib/auth-client";

export function MemberManagement({ organization, currentUserId, canManage, onChanged }: {
  organization: FullOrganization;
  currentUserId: string;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  async function updateRole(memberId: string, role: string) {
    await postAuth("/api/auth/organization/update-member-role", {
      organizationId: organization.id,
      memberId,
      role,
    });
    await onChanged();
  }

  async function remove(memberId: string) {
    if (!window.confirm("Remove this person from the home? Their access will stop immediately.")) return;
    await postAuth("/api/auth/organization/remove-member", {
      organizationId: organization.id,
      memberIdOrEmail: memberId,
    });
    await onChanged();
  }

  return <section className="settings-section" aria-labelledby="members-title">
    <header><div><p>Access</p><h2 id="members-title">Members</h2></div><span>{organization.members.length}</span></header>
    <div className="settings-list">
      {organization.members.map((member) => <article key={member.id}>
        <span className="settings-avatar" title={member.user?.name}><UserCircle size={24} /></span>
        <div><strong>{member.user?.name ?? "Home member"}{member.userId === currentUserId ? " (you)" : ""}</strong><small>{member.user?.email}</small></div>
        {canManage && member.userId !== currentUserId ? <>
          <select aria-label={`Role for ${member.user?.name ?? member.userId}`} value={member.role.split(",")[0]} onChange={(event) => void updateRole(member.id, event.target.value)}>
            <option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option>
          </select>
          <button className="icon-button icon-button--small" aria-label={`Remove ${member.user?.name ?? member.userId}`} onClick={() => void remove(member.id)}><Trash size={16} /></button>
        </> : <span className="role-pill">{member.role}</span>}
      </article>)}
    </div>
  </section>;
}
