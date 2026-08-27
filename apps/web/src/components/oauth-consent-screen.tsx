"use client";

import { useMemo, useState } from "react";
import { LockKey, Package, Scroll } from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";

export function OAuthConsentScreen() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requested = useMemo(() => {
    if (typeof window === "undefined") return [];
    return new URLSearchParams(window.location.search).get("scope")?.split(" ").filter(Boolean) ?? [];
  }, []);

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    const result = await authClient.oauth2.consent({ accept });
    if (result.error) {
      setError(result.error.message ?? "Authorization could not be completed.");
      setPending(false);
    }
  }

  return <main className="auth-page"><section className="auth-card" aria-labelledby="consent-title">
    <div className="auth-brand"><span><LockKey size={21} weight="fill" /></span>Secure connection</div>
    <p className="auth-eyebrow">Home OS MCP</p><h1 id="consent-title">Let this assistant read your current home?</h1>
    <p className="auth-copy">The connection is tied to the home you selected. Changing membership or signing out revokes access.</p>
    <div className="consent-permissions"><p><Package size={20} /><span><strong>Inventory</strong><small>Names, categories, locations, stock, and forecasts</small></span></p><p><Scroll size={20} /><span><strong>Activity</strong><small>The append-only household audit trail</small></span></p></div>
    {requested.length > 0 && <p className="consent-scopes">Requested: {requested.join(" · ")}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="consent-actions"><button className="button button--quiet" disabled={pending} onClick={() => void decide(false)}>Deny</button><button className="button button--primary" disabled={pending} onClick={() => void decide(true)}>{pending ? "Connecting…" : "Allow access"}</button></div>
  </section></main>;
}
