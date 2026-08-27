"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Trash, UsersThree } from "@phosphor-icons/react";
import { authRequest, postAuth, type FullOrganization } from "@/lib/auth-client";

interface TeamMember { id: string; teamId: string; userId: string }

export function GroupManagement({ organization, canManage, onChanged }: {
  organization: FullOrganization;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selectedTeam, setSelectedTeam] = useState(organization.teams[0]?.id ?? "");
  const [selectedUser, setSelectedUser] = useState(organization.members[0]?.userId ?? "");
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);

  useEffect(() => {
    if (!selectedTeam) return;
    let active = true;
    void authRequest<TeamMember[]>(`/api/auth/organization/list-team-members?teamId=${encodeURIComponent(selectedTeam)}`)
      .then((members) => { if (active) setTeamMembers(members); });
    return () => { active = false; };
  }, [selectedTeam, organization.id]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const team = await postAuth<{ id: string }>("/api/auth/organization/create-team", { name, organizationId: organization.id });
    setName("");
    setSelectedTeam(team.id);
    await onChanged();
  }

  async function addMember() {
    await postAuth("/api/auth/organization/add-team-member", { teamId: selectedTeam, userId: selectedUser, organizationId: organization.id });
    setTeamMembers(await authRequest<TeamMember[]>(`/api/auth/organization/list-team-members?teamId=${encodeURIComponent(selectedTeam)}`));
  }

  async function removeMember(userId: string) {
    await postAuth("/api/auth/organization/remove-team-member", { teamId: selectedTeam, userId, organizationId: organization.id });
    setTeamMembers((current) => current.filter((member) => member.userId !== userId));
  }

  async function removeTeam(teamId: string) {
    await postAuth("/api/auth/organization/remove-team", { teamId, organizationId: organization.id });
    setSelectedTeam("");
    await onChanged();
  }

  return <section className="settings-section" aria-labelledby="groups-title">
    <header><div><p>Rooms & responsibilities</p><h2 id="groups-title">Groups</h2></div><span>{organization.teams.length}</span></header>
    {canManage && <form className="settings-inline-form" onSubmit={(event) => void create(event)}><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Kitchen or Grocery crew" aria-label="Group name" /><button className="button button--primary">Create group</button></form>}
    <div className="team-chips">{organization.teams.map((team) => <button className={selectedTeam === team.id ? "is-active" : ""} key={team.id} onClick={() => setSelectedTeam(team.id)}><UsersThree size={16} />{team.name}<small>{team.memberCount ?? 0}</small></button>)}</div>
    {selectedTeam && <div className="group-members">
      {canManage && <div className="settings-inline-form"><select aria-label="Member to add to group" value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)}>{organization.members.map((member) => <option key={member.userId} value={member.userId}>{member.user?.name ?? member.userId}</option>)}</select><button className="button button--quiet" onClick={() => void addMember()} disabled={!selectedUser}>Add to group</button><button className="button button--danger" onClick={() => void removeTeam(selectedTeam)}>Delete group</button></div>}
      <div className="settings-list">{teamMembers.map((teamMember) => { const member = organization.members.find((candidate) => candidate.userId === teamMember.userId); return <article key={teamMember.id}><div><strong>{member?.user?.name ?? teamMember.userId}</strong><small>{member?.user?.email}</small></div>{canManage && <button className="icon-button icon-button--small" aria-label={`Remove ${member?.user?.name ?? teamMember.userId} from group`} onClick={() => void removeMember(teamMember.userId)}><Trash size={16} /></button>}</article>; })}</div>
    </div>}
  </section>;
}
