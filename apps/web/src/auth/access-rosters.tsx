"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Fresh document navigation returns from Worker aliases and re-reads the allowlisted app location. */

import { useCallback, useEffect, useRef, useState } from "react";
import { getMembers, listBrowserSessions, revokeBrowserSession, type AuthSession, type BrowserSessionAccess, type MemberAccount } from "@/lib/auth";
import { homeOSDatabase } from "@/offline/db";
import { captureAccessProof, isCurrentAccessProof } from "./work";
import { listConnections, revokeConnection, type AssistantConnection } from "./connections";

type Page<T> = { rows: T[]; cursor: string | null };

function AccessRoster({ kind, memberId, online, hasPendingChanges }: { kind: "sessions" | "connections"; memberId: string; online: boolean; hasPendingChanges: boolean }) {
  const [page, setPage] = useState<Page<BrowserSessionAccess | AssistantConnection>>({ rows: [], cursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const busy = useRef(false);
  const active = useRef(true);
  const load = useCallback(async (cursor?: string) => {
    if (!online || busy.current) { setLoading(false); return; }
    busy.current = true;
    const proof = captureAccessProof();
    setLoading(true); setError("");
    try {
      const input = { memberId, limit: 10, ...(cursor ? { cursor } : {}) };
      const data = kind === "sessions" ? await listBrowserSessions(input) : await listConnections(input);
      if (!active.current || !isCurrentAccessProof(proof)) return;
      const rows = "sessions" in data ? data.sessions : data.connections;
      setPage(previous => ({ rows: cursor ? [...previous.rows, ...rows] : rows, cursor: data.nextCursor }));
    } catch (failure) {
      if (active.current && isCurrentAccessProof(proof)) setError(failure instanceof Error ? failure.message : "Access could not be loaded. Try again.");
    } finally { busy.current = false; if (active.current) setLoading(false); }
  }, [kind, memberId, online]);
  useEffect(() => {
    active.current = true;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void load(); });
    return () => { mounted = false; active.current = false; };
  }, [load]);

  async function revoke(row: BrowserSessionAccess | AssistantConnection) {
    if (busy.current || !online || ("current" in row && row.current && hasPendingChanges)) return;
    busy.current = true; setPending(row.id); setError(""); setNotice("");
    const proof = captureAccessProof();
    try {
      if ("current" in row && row.current && await homeOSDatabase.outbox.count() > 0) throw new Error("Sync your saved changes before ending this browser’s access. Your changes are kept on this device.");
      if (!active.current || !isCurrentAccessProof(proof)) return;
      if (kind === "sessions") await revokeBrowserSession(row.id);
      else await revokeConnection(row.id);
      if (!active.current || !isCurrentAccessProof(proof)) return;
      setPage(previous => ({ ...previous, rows: kind === "sessions" ? previous.rows.filter(item => item.id !== row.id) : previous.rows.map(item => item.id === row.id ? { ...item, status: "ended" as const } : item) }));
      setNotice("Access ended.");
    } catch (failure) {
      if (active.current && isCurrentAccessProof(proof)) setError(failure instanceof Error ? failure.message : "Access could not be ended. Try again.");
    } finally { busy.current = false; if (active.current) setPending(null); }
  }
  const title = kind === "sessions" ? "Browser sessions" : "Assistant connections";
  return <section className="account-section" aria-label={title}>
    <h3>{title}</h3>
    <p className="account-description">{kind === "sessions" ? "Each sign-in is separate. Ending one also ends its push notification access." : "Each assistant acts within its approved role and your current access. Reconnect from your assistant to approve a broader role."}</p>
    {!online && <p className="account-offline">Connect to check or end access. Previously loaded records may have changed.</p>}
    {loading && <p role="status">Loading {title.toLowerCase()}…</p>}
    {error && <div className="access-feedback"><p role="alert" className="form-error">{error}</p><button className="button button--quiet" disabled={!online || loading || !!pending} onClick={() => void load()}>Retry {title.toLowerCase()}</button></div>}
    {notice && <p role="status" className="account-success">{notice}</p>}
    {!loading && !error && online && !page.rows.length && <p className="account-description access-empty">No {title.toLowerCase()} to show.</p>}
    <ul className="access-list">{page.rows.map(row => <li className="access-row" key={row.id}>
      <div className="access-row__detail">
        <strong>{"clientName" in row ? row.clientName : row.current ? "This browser" : "Other browser"}</strong>
        {"status" in row && <span className={`members-status${row.status === "ended" ? " members-status--inactive" : ""}`}>{row.status === "authorized" ? "Authorized" : row.status === "not_used_yet" ? "Not used yet" : "Ended"}</span>}
        <p className="account-description">Started <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>{"approvedRole" in row ? ` · Approved as ${row.approvedRole}` : row.expiresAt === null ? " · No automatic expiry" : " · Legacy sign-in"}</p>
        {"current" in row && row.current && hasPendingChanges && <p className="auth-help">Sync your saved changes before ending this browser’s access. They will be kept on this device.</p>}
      </div>
      {!("status" in row && row.status === "ended") && <button className="button button--quiet" aria-label={`End access for ${"clientName" in row ? row.clientName : row.current ? "this browser" : "browser started " + new Date(row.createdAt).toLocaleString()}`} disabled={!online || !!pending || loading || ("current" in row && row.current && hasPendingChanges)} onClick={() => void revoke(row)}>{pending === row.id ? "Ending…" : "End access"}</button>}
    </li>)}</ul>
    {page.cursor && <button className="button button--quiet" disabled={!online || loading || !!pending} onClick={() => void load(page.cursor!)}>Load more {title.toLowerCase()}</button>}
  </section>;
}

export function AccessRosters({ session, online, hasPendingChanges }: { session: AuthSession; online: boolean; hasPendingChanges: boolean }) {
  const [members, setMembers] = useState<MemberAccount[]>([]);
  const [memberId, setMemberId] = useState(session.user.id);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (session.user.role !== "owner" || !online) return;
    let active = true;
    const proof = captureAccessProof();
    void getMembers().then(rows => { if (active && isCurrentAccessProof(proof)) { setMembers(rows); setError(""); } }, failure => { if (active && isCurrentAccessProof(proof)) setError(failure instanceof Error ? failure.message : "People could not be loaded."); });
    return () => { active = false; };
  }, [session.user.role, online, retry]);
  return <>
    {session.user.role === "owner" && <div className="account-section">
      <h3>Household access</h3>
      <label className="field auth-field"><span>Show access for</span><select value={memberId} disabled={!online} onChange={event => setMemberId(event.target.value)}>
        <option value={session.user.id}>{session.user.name} · You</option>
        {members.filter(member => member.id !== session.user.id).map(member => <option key={member.id} value={member.id}>{member.name}{!member.active ? " · Inactive" : ""}</option>)}
      </select></label>
      <a className="access-link" href="/?view=members">Manage household members</a>
      {error && <><p className="form-error" role="alert">{error}</p><button className="button button--quiet" disabled={!online} onClick={() => setRetry(value => value + 1)}>Retry people</button></>}
    </div>}
    <AccessRoster key={`sessions:${memberId}:${session.sessionId ?? "legacy"}`} kind="sessions" memberId={memberId} online={online} hasPendingChanges={hasPendingChanges} />
    <AccessRoster key={`connections:${memberId}:${session.sessionId ?? "legacy"}`} kind="connections" memberId={memberId} online={online} hasPendingChanges={hasPendingChanges} />
  </>;
}
