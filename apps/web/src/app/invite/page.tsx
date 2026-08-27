"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle, House } from "@phosphor-icons/react";
import { loadHomeSession, postAuth } from "@/lib/auth-client";
import { SignInScreen } from "@/components/sign-in-screen";

export default function InvitationPage() {
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "accepted" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const invitationId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("id") ?? "";

  useEffect(() => {
    void loadHomeSession().then((session) => setState(session.authenticated ? "ready" : "signed-out")).catch((problem) => {
      setError(problem instanceof Error ? problem.message : "The invitation could not be opened.");
      setState("error");
    });
  }, []);

  if (state === "signed-out") return <SignInScreen returnTo={window.location.href} />;
  async function accept() {
    try {
      await postAuth<{ invitation: { organizationId: string } }>("/api/auth/organization/accept-invitation", { invitationId });
      setState("accepted");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The invitation could not be accepted.");
      setState("error");
    }
  }

  return <main className="auth-page"><section className="auth-card">
    <div className="auth-brand"><span><House size={21} weight="fill" /></span>Home OS invitation</div>
    {state === "loading" && <p>Opening invitation…</p>}
    {state === "ready" && <><h1>Join this home?</h1><p className="auth-copy">Your verified Google email must match the invitation. Once joined, this home appears in your switcher.</p><button className="button button--primary" onClick={() => void accept()} disabled={!invitationId}>Accept invitation</button></>}
    {state === "accepted" && <><CheckCircle size={38} color="var(--accent)" weight="fill" /><h1>You joined the home.</h1><Link className="button button--primary" href="/">Open Home OS</Link></>}
    {state === "error" && <><h1>Invitation unavailable</h1><p className="form-error" role="alert">{error}</p><Link className="button button--quiet" href="/">Return home</Link></>}
  </section></main>;
}
