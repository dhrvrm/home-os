"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createMember, getMembers, resetMemberPassword, updateMember, type AuthUser, type MemberAccount } from "@/lib/auth";
import { errorMessage, PasswordField } from "./auth-fields";
import "./auth.css";

type Editor = { memberId: string; mode: "edit" | "password" | "deactivate" };

export function MembersView({ currentUser }: { currentUser: AuthUser }) {
  const [members, setMembers] = useState<MemberAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const owner = currentUser.role === "owner";

  const load = useCallback(async () => {
    try {
      setMembers(await getMembers());
      setLoadError(null);
    }
    catch (failure) { setLoadError(errorMessage(failure, "Household members could not be loaded.")); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine);
    refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => { window.removeEventListener("online", refresh); window.removeEventListener("offline", refresh); };
  }, []);

  function closeEditor() { setEditor(null); setAdding(false); setFormError(null); }
  function openEditor(memberId: string, mode: Editor["mode"]) {
    setAdding(false);
    setEditor({ memberId, mode });
    setFormError(null);
    setNotice(null);
  }
  function replaceMember(updated: MemberAccount) {
    setMembers((existing) => existing.map((member) => member.id === updated.id ? updated : member));
  }

  async function submitNew(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? "");
    if (password !== values.get("confirmPassword")) { setFormError("Passwords do not match."); return; }
    setPending(true);
    setFormError(null);
    try {
      const member = await createMember({ name: String(values.get("name") ?? "").trim(), email: String(values.get("email") ?? "").trim(), password, role: String(values.get("role")) as MemberAccount["role"] });
      setMembers((existing) => [...existing, member]);
      closeEditor();
      setNotice(`${member.name} can now sign in. Share the initial password with them privately.`);
    } catch (failure) { setFormError(errorMessage(failure, "The member could not be added.")); }
    finally { setPending(false); }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>, member: MemberAccount) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    try {
      const role = values.get("role");
      const updated = await updateMember(member.id, { name: String(values.get("name") ?? "").trim(), email: String(values.get("email") ?? "").trim(), ...(role ? { role: String(role) as MemberAccount["role"] } : {}) });
      replaceMember(updated);
      closeEditor();
      setNotice(`${updated.name}’s details were saved.`);
    } catch (failure) { setFormError(errorMessage(failure, "The member could not be updated.")); }
    finally { setPending(false); }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>, member: MemberAccount) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? "");
    if (password !== values.get("confirmPassword")) { setFormError("Passwords do not match."); return; }
    setPending(true);
    setFormError(null);
    try {
      await resetMemberPassword(member.id, password);
      replaceMember({ ...member, hasLogin: true });
      closeEditor();
      setNotice(`${member.name}’s password was saved and their previous sessions were ended.`);
    } catch (failure) { setFormError(errorMessage(failure, "The password could not be saved.")); }
    finally { setPending(false); }
  }

  async function setActive(member: MemberAccount, active: boolean) {
    if (pending) return;
    setPending(true);
    setFormError(null);
    setNotice(null);
    try {
      replaceMember(await updateMember(member.id, { active }));
      closeEditor();
      setNotice(active ? `${member.name} can access the home again.` : `${member.name} was deactivated. Their history is kept.`);
    } catch (failure) {
      setEditor({ memberId: member.id, mode: active ? "edit" : "deactivate" });
      setFormError(errorMessage(failure, "Access could not be updated."));
    } finally { setPending(false); }
  }

  const activeOwners = members.filter((member) => member.active && member.role === "owner").length;

  return (
    <section className="members-panel" aria-labelledby="members-title">
      <header className="members-heading">
        <div><h2 id="members-title">People at home</h2><p>{loading ? "Loading your household" : `${activeOwners} ${activeOwners === 1 ? "owner" : "owners"} · ${members.filter((member) => member.active).length} active · ${members.filter((member) => !member.active).length} inactive`}</p></div>
        {owner && !adding && <button className="button button--primary" type="button" disabled={loading || pending || !online} onClick={() => { closeEditor(); setAdding(true); setNotice(null); }}>Add member</button>}
      </header>
      {owner && <p className="account-description">You can have several home owners. Choose Owner access when adding or editing a member to let them manage accounts too.</p>}
      {!online && <div className="members-feedback"><p className="account-offline" role="status">Connect to manage household members and account access.</p></div>}
      {!owner && <div className="members-feedback"><p className="account-description">Household owners manage accounts and access. {currentUser.role === "viewer" ? "Your account has view-only access." : "Ask an owner if someone needs to be added."}</p></div>}
      {notice && <div className="members-feedback"><p className="account-success" role="status">{notice}</p></div>}
      {loadError && <div className="members-feedback"><p className="form-error" role="alert">{loadError}</p><button className="button button--quiet" type="button" style={{ marginTop: 12 }} onClick={() => { setLoading(true); setLoadError(null); void load(); }}>Try again</button></div>}
      {adding && <section className="members-add" aria-labelledby="new-member-title">
        <h3 id="new-member-title">Add someone to your home</h3>
        <p className="account-description">Give them an account with their own email and an initial password.</p>
        <form className="account-form" aria-label="Add household member" onSubmit={submitNew} aria-busy={pending}>
          <label className="field auth-field"><span>Name</span><input name="name" required maxLength={80} disabled={pending} autoComplete="name" autoFocus /></label>
          <label className="field auth-field"><span>Email</span><input name="email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={254} disabled={pending} /></label>
          <label className="field auth-field"><span>Access</span><select name="role" defaultValue="member" disabled={pending}><RoleOptions /></select><small className="auth-help">Members can update household data. Owners also manage accounts. Viewers can only read.</small></label>
          <PasswordField label="Initial password" name="password" autoComplete="new-password" disabled={pending} help="Use 12–128 characters and share it privately. They can change it in Account." />
          <PasswordField label="Confirm initial password" name="confirmPassword" autoComplete="new-password" disabled={pending} />
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <div className="account-form__actions"><button type="submit" className="button button--primary" disabled={pending || !online}>{pending ? "Creating…" : "Create member"}</button><button type="button" className="button button--quiet" onClick={closeEditor} disabled={pending}>Cancel</button></div>
        </form>
      </section>}
      {loading && <p className="members-loading" role="status">Loading household members…</p>}
      {!loading && !loadError && members.length === 0 && <p className="members-empty">No household members yet.</p>}
      {!loading && <div className="members-list">
        {members.map((member) => <article className="member-row" key={member.id} aria-label={member.name}>
          <div className="member-row__summary">
            <div className="member-row__identity">
              <div className="member-row__name"><h3>{member.name}{member.id === currentUser.id && <span className="auth-help"> · You</span>}</h3><span className={`members-status${member.active ? "" : " members-status--inactive"}`}>{member.active ? "Active" : "Inactive"}</span></div>
              <p>{member.email ?? "No email set"} · {member.role === "owner" ? "Owner" : member.role === "viewer" ? "Viewer" : "Member"}{!member.hasLogin && " · No sign-in password yet"}</p>
            </div>
            {owner && <div className="member-row__actions">
              <button type="button" className="button button--quiet" disabled={pending || !online} onClick={() => openEditor(member.id, "edit")}>Edit</button>
              {member.id !== currentUser.id && member.active && <button type="button" className="button button--quiet" disabled={pending || !online || !member.email} onClick={() => openEditor(member.id, "password")}>{member.hasLogin ? "Reset password" : "Set sign-in password"}</button>}
              {member.id !== currentUser.id && member.active && !(member.role === "owner" && activeOwners < 2) && <button type="button" className="button button--quiet" disabled={pending || !online} onClick={() => openEditor(member.id, "deactivate")}>Deactivate</button>}
              {!member.active && <button type="button" className="button button--quiet" disabled={pending || !online} onClick={() => void setActive(member, true)}>Reactivate</button>}
            </div>}
          </div>
          {editor?.memberId === member.id && <div className="member-editor">
            {editor.mode === "edit" && <>
              <h4>Edit {member.name}</h4>
              <form className="account-form" onSubmit={(event) => void submitEdit(event, member)} aria-busy={pending} aria-label={`Edit ${member.name}`}>
                <label className="field auth-field"><span>Name</span><input name="name" defaultValue={member.name} required maxLength={80} disabled={pending} autoFocus /></label>
                <label className="field auth-field"><span>Email</span><input name="email" type="email" inputMode="email" defaultValue={member.email ?? ""} required maxLength={254} autoCapitalize="none" spellCheck={false} disabled={pending} /></label>
                <label className="field auth-field"><span>Access</span><select name="role" defaultValue={member.role} disabled={pending || (member.role === "owner" && (member.id === currentUser.id || activeOwners < 2))}><RoleOptions /></select></label>
                {member.role === "owner" && activeOwners < 2 && <p className="auth-help">The home must keep at least one active owner.</p>}
                {formError && <p className="form-error" role="alert">{formError}</p>}
                <div className="account-form__actions"><button type="submit" className="button button--primary" disabled={pending || !online}>{pending ? "Saving…" : "Save details"}</button><button type="button" className="button button--quiet" onClick={closeEditor} disabled={pending}>Cancel</button></div>
              </form>
            </>}
            {editor.mode === "password" && <>
              <h4>{member.hasLogin ? "Reset" : "Set"} {member.name}’s password</h4>
              <form className="account-form" onSubmit={(event) => void submitPassword(event, member)} aria-busy={pending} aria-label={`Password for ${member.name}`}>
                <p className="account-description">Their existing sessions will end. Share the new password privately.</p>
                <PasswordField label={`New password for ${member.name}`} name="password" autoComplete="new-password" disabled={pending} help="Use 12–128 characters." />
                <PasswordField label={`Confirm new password for ${member.name}`} name="confirmPassword" autoComplete="new-password" disabled={pending} />
                {formError && <p className="form-error" role="alert">{formError}</p>}
                <div className="account-form__actions"><button type="submit" className="button button--primary" disabled={pending || !online}>{pending ? "Saving…" : "Save new password"}</button><button type="button" className="button button--quiet" onClick={closeEditor} disabled={pending}>Cancel</button></div>
              </form>
            </>}
            {editor.mode === "deactivate" && <>
              <h4>Deactivate {member.name}?</h4>
              <p className="account-description">Their sessions will end. Past inventory activity and expense shares stay linked to them. You can reactivate them later.</p>
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <div className="account-form__actions" style={{ marginTop: 16 }}><button type="button" className="button button--danger" disabled={pending || !online} onClick={() => void setActive(member, false)}>{pending ? "Deactivating…" : `Deactivate ${member.name}`}</button><button type="button" className="button button--quiet" onClick={closeEditor} disabled={pending}>Cancel</button></div>
            </>}
          </div>}
        </article>)}
      </div>}
    </section>
  );
}

function RoleOptions() {
  return <><option value="member">Member</option><option value="owner">Owner</option><option value="viewer">Viewer · view only</option></>;
}
