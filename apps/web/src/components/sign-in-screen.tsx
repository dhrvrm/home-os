"use client";

import { useState } from "react";
import { House, ShieldCheck } from "@phosphor-icons/react";
import { authClient } from "@/lib/auth-client";

export function SignInScreen({ returnTo = "/" }: { returnTo?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);
    const result = await authClient.signIn.social({ provider: "google", callbackURL: returnTo });
    if (result.error) {
      setError(result.error.message ?? "Google sign-in could not start.");
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-brand"><span><House size={22} weight="fill" /></span>Home OS</div>
        <p className="auth-eyebrow">Your shared home, organized</p>
        <h1 id="sign-in-title">Know what your home has—and who it belongs to.</h1>
        <p className="auth-copy">Inventory stays useful offline. Google secures your account, while each home keeps its members and data separate.</p>
        <button className="google-button" type="button" onClick={() => void signIn()} disabled={pending}>
          <GoogleMark />
          {pending ? "Opening Google…" : "Continue with Google"}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="auth-assurance"><ShieldCheck size={16} weight="fill" /> Home OS never receives your Google password.</p>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <span className="google-mark" aria-hidden="true">G</span>;
}
