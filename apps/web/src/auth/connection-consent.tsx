"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Fresh document navigation returns from Worker aliases and re-reads the allowlisted app location. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthSession } from "@/lib/auth";
import { getConsent, decideConsent, type ConsentPreview } from "./connections";
import { captureAccessProof, isCurrentAccessProof, type AccessProof } from "./work";

function capabilityLabel(action: string): string {
  const special: Record<string, string> = { home_context: "Read your household and access details", inventory_attention: "Read inventory needing attention", inventory_stock: "Record inventory use and restocking", inventory_events: "Read inventory history", inventory_export: "Export inventory", activity_list: "Read household activity", meal_attendance_set: "Answer your own meal attendance", notifications_list: "Read your reminders", notifications_mark_read: "Mark your reminders read", notification_preferences_get: "Read your reminder preferences", notification_preferences_set: "Change your reminder preferences", members_update: "Manage household members", connections_list: "Inspect permitted assistant connections", connections_revoke: "End permitted assistant connections", sessions_list: "Inspect permitted browser sessions", sessions_revoke: "End permitted browser sessions" };
  if (special[action]) return special[action];
  const match = /^(inventory|expenses|recipes|meals|contacts|members)_(list|get|create|update|archive|restore|cancel)$/.exec(action);
  if (match) return `${({ list: "Read", get: "Read details of", create: "Create", update: "Edit", archive: "Archive", restore: "Restore", cancel: "Cancel" } as Record<string, string>)[match[2]]} ${({ inventory: "inventory", expenses: "expense rules", recipes: "recipes", meals: "meals", contacts: "contacts", members: "household members" } as Record<string, string>)[match[1]]}`;
  return "An additional household permission (refresh this app to review it)";
}

function capabilitySummary(preview: ConsentPreview): string[] {
  const actions = new Set(preview.capabilities);
  const summaries: string[] = [];
  if (actions.has("home_context")) summaries.push("Read household details");
  if (actions.has("activity_list")) summaries.push("Read shared household activity");
  for (const [domain, label] of [["inventory", "inventory"], ["expenses", "expense rules"], ["recipes", "recipes"], ["meals", "meals"], ["contacts", "contacts"]] as const) {
    const available = preview.capabilities.filter(action => action.startsWith(`${domain}_`));
    if (!available.length) continue;
    const writes = available.some(action => /_(create|update|stock|archive|restore|cancel)$/.test(action));
    summaries.push(`${writes ? "Read and maintain" : "Read"} ${label}${domain === "inventory" && actions.has("inventory_export") ? ", including exports" : ""}`);
  }
  if (actions.has("meal_attendance_set")) summaries.push("Answer only your own meal attendance");
  const reminders = preview.capabilities.some(action => action.startsWith("notifications_"));
  const preferences = preview.capabilities.some(action => action.startsWith("notification_preferences_"));
  if (reminders || preferences) {
    const changes = actions.has("notifications_mark_read") || actions.has("notification_preferences_set");
    summaries.push(`${changes ? "Manage" : "Read"} your own ${reminders && preferences ? "reminders and preferences" : reminders ? "reminders" : "reminder preferences"}`);
  }
  if (actions.has("members_list") || actions.has("members_update")) summaries.push(`${actions.has("members_update") ? "Read and manage" : "Read"} household members`);
  const browsers = actions.has("sessions_list") || actions.has("sessions_revoke");
  const assistants = actions.has("connections_list") || actions.has("connections_revoke");
  if (browsers || assistants) {
    const end = actions.has("sessions_revoke") || actions.has("connections_revoke");
    const owner = preview.approvedRole === "owner" && preview.member.role === "owner";
    summaries.push(`${end ? "Inspect and end" : "Inspect"} ${owner ? "household" : "your own"} ${browsers && assistants ? "browser and assistant access" : browsers ? "browser access" : "assistant access"}`);
  }
  return summaries;
}

export function ConnectionConsent({ intentId, session, online, onRedirect = url => window.location.assign(url) }: { intentId: string; session: AuthSession; online: boolean; onRedirect?: (url: string) => void }) {
  const [review, setReview] = useState<{ preview: ConsentPreview; proof: AccessProof } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const load = useCallback(async () => {
    if (!online || busy.current) { setLoading(false); return; }
    busy.current = true; setLoading(true); setReview(null); setError(""); setExpired(false);
    const proof = captureAccessProof();
    try {
      const preview = await getConsent(intentId);
      if (!active.current || !isCurrentAccessProof(proof)) return;
      if (preview.id !== intentId || preview.member.id !== session.user.id || preview.member.role !== session.user.role || !Number.isFinite(Date.parse(preview.expiresAt))) throw new Error("Your account or access changed. Review this connection again.");
      setReview({ preview, proof }); setExpired(Date.parse(preview.expiresAt) <= Date.now());
    } catch (failure) { if (active.current && isCurrentAccessProof(proof)) setError(failure instanceof Error ? failure.message : "This connection could not be reviewed."); }
    finally { busy.current = false; if (active.current) setLoading(false); }
  }, [intentId, session.user.id, session.user.role, online]);
  useEffect(() => {
    active.current = true;
    let mounted = true;
    queueMicrotask(() => { if (mounted) void load(); });
    return () => { mounted = false; active.current = false; };
  }, [load, session.sessionId]);
  useEffect(() => {
    if (!review) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(review.preview.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [review]);

  async function decide(decision: "approve" | "deny") {
    if (!review || busy.current || !online || expired) return;
    if (!isCurrentAccessProof(review.proof)) { setReview(null); setError("Sign-in changed. Review the connection again before deciding."); return; }
    busy.current = true; setPending(decision); setError("");
    try {
      const result = await decideConsent(intentId, decision);
      if (!active.current || !isCurrentAccessProof(review.proof)) return;
      // Only the server's validated callback is used; query parameters never select it.
      onRedirect(result.redirectTo);
    } catch (failure) {
      if (active.current && isCurrentAccessProof(review.proof)) { setReview(null); setError(failure instanceof Error ? failure.message : "The decision could not be completed. Review and retry."); }
    } finally { busy.current = false; if (active.current) setPending(null); }
  }
  const preview = review?.preview;
  const unknownCapability = preview?.capabilities.some(action => capabilityLabel(action).startsWith("An additional"));
  return <section className="account-panel consent-panel" aria-labelledby="consent-title">
    <div className="account-section">
      <p className="auth-eyebrow">Assistant connection</p><h2 id="consent-title">Review access to your home</h2>
      <p className="account-description">Signed in as {session.user.name} · {session.user.role}. Only allow a connection you started.</p>
      {!online && <p className="account-offline" role="status">You’re offline. Connect to review the request, check its current status and decide.</p>}
      {loading && <p role="status">Loading connection details…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {expired && <p role="alert" className="account-offline">This review has expired. Review again, or restart the connection from your assistant.</p>}
      {(!review || error || expired) && !loading && <button className="button button--quiet" disabled={!online || !!pending} onClick={() => void load()}>Review again</button>}
    </div>
    {preview && <>
      <div className="account-section">
        <h3>{preview.client.clientName}</h3>
        {preview.client.clientDomain ? <p className="consent-domain">Verified domain: <strong>{preview.client.clientDomain}</strong></p> : <p className="account-offline">Unverified client name. Home OS has not verified who owns this name.</p>}
        <dl className="consent-details"><dt>Return destination</dt><dd><strong>{preview.client.redirectHost}</strong><span>{preview.client.redirectUri}</span></dd><dt>Home OS resource</dt><dd>{preview.resource}</dd><dt>Approved role</dt><dd>{preview.approvedRole}</dd></dl>
        {preview.client.redirectIsLoopback && <p className="auth-notice">This returns to an app on your device (a local address). Any local process may be listening at this address. Continue only if you started this connection in that app.</p>}
      </div>
      <div className="account-section"><h3>What this assistant can do</h3><ul className="consent-capabilities" aria-label="Permission summary">{capabilitySummary(preview).map(label => <li key={label}>{label}</li>)}</ul><details className="consent-permission-details"><summary>Full permission details</summary><ul className="consent-capabilities" aria-label="Full permissions">{[...new Set(preview.capabilities.map(capabilityLabel))].map(label => <li key={label}>{label}</li>)}</ul></details>{unknownCapability && <p role="alert" className="account-offline">Update Home OS to review all requested permissions before allowing.</p>}<p className="account-description">Your current role always limits access. A promotion does not expand this approval; reconnect from your assistant for a broader role. You can end access in Account.</p></div>
      <div className="account-section account-form__actions"><button className="button button--primary" disabled={!online || !!pending || expired || unknownCapability} onClick={() => void decide("approve")}>{pending === "approve" ? "Allowing…" : "Allow"}</button><button className="button button--quiet" disabled={!online || !!pending || expired} onClick={() => void decide("deny")}>{pending === "deny" ? "Denying…" : "Deny"}</button></div>
    </>}
    <div className="account-section"><a className="access-link" href="/">Return to Home OS</a><p className="auth-help">Returning leaves this request unapproved.</p></div>
  </section>;
}
