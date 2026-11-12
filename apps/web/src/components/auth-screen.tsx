"use client";

import { useState, type FormEvent } from "react";
import { House } from "@phosphor-icons/react";
import { login, setupOwner, type AuthSession } from "@/lib/auth";
import { errorMessage, PasswordField } from "./auth-fields";
import "./auth.css";

interface AuthScreenProps {
  setupRequired: boolean;
  setupAvailable: boolean;
  message?: string;
  onAuthenticated: (session: AuthSession) => Promise<void> | void;
}

export function AuthScreen({ setupRequired, setupAvailable, message, onAuthenticated }: AuthScreenProps) {
  const [signInInstead, setSignInInstead] = useState(false);
  const settingUp = setupRequired && !signInInstead;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? "");
    if (settingUp && password !== values.get("confirmPassword")) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const credentials = { email: String(values.get("email") ?? "").trim(), password, remember: values.get("remember") === "on" };
      const session = settingUp
        ? await setupOwner({ ...credentials, name: String(values.get("name") ?? "").trim(), setupToken: String(values.get("setupToken") ?? "") })
        : await login(credentials);
      await onAuthenticated(session);
    } catch (failure) {
      setError(errorMessage(failure, "Home OS could not sign you in. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand"><span className="brand__mark"><House size={19} weight="fill" aria-hidden="true" /></span><strong>Home OS</strong></div>
        <header className="auth-intro">
          <p className="auth-eyebrow">Your shared home</p>
          <h1 id="auth-title">{settingUp ? "A place for everyone at home." : "Welcome home."}</h1>
          <p>{settingUp ? "Create the first owner account, then add the people you live with." : "Sign in to your household’s inventory and shared plans."}</p>
        </header>
        {message && <p className="auth-notice" role="status">{message}</p>}
        {settingUp && !setupAvailable
          ? <p className="auth-notice" role="status">Home setup is not ready yet. Ask the person setting up Home OS to enable account setup, then reload this page.</p>
          : <form className="auth-form" onSubmit={submit} aria-busy={pending}>
            {settingUp && <label className="field auth-field"><span>Your name</span><input name="name" autoComplete="name" required maxLength={80} disabled={pending} /></label>}
            <label className="field auth-field"><span>Email</span><input name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} disabled={pending} /></label>
            <PasswordField label="Password" name="password" autoComplete={settingUp ? "new-password" : "current-password"} disabled={pending} help={settingUp ? "Use 12–128 characters. A few words work well." : undefined} />
            {settingUp && <>
              <PasswordField label="Confirm password" name="confirmPassword" autoComplete="new-password" disabled={pending} />
              <div className="field auth-field"><label htmlFor="home-setup-code">Home setup code</label><input id="home-setup-code" name="setupToken" type="password" autoComplete="off" required maxLength={256} disabled={pending} aria-describedby="setup-code-help" /><small className="auth-help" id="setup-code-help">The private setup code from the person setting up this home. Used only for the first owner.</small></div>
            </>}
            <label className="auth-check"><input name="remember" type="checkbox" defaultChecked disabled={pending} /><span>Keep me signed in</span></label>
            <p className="auth-help auth-remember-help">For 30 days on this device. Leave unchecked on a shared device.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="submit" className="button button--primary auth-submit" disabled={pending}>{pending ? (settingUp ? "Setting up…" : "Signing in…") : (settingUp ? "Set up your home" : "Sign in")}</button>
            {!settingUp && <p className="auth-help">Need an account or a new password? Ask a household owner.</p>}
          </form>}
        {setupRequired && <button className="button button--quiet" style={{ width: "100%", marginTop: 16 }} type="button" disabled={pending} onClick={() => { setSignInInstead((current) => !current); setError(null); }}>{settingUp ? "Sign in instead" : "Back to home setup"}</button>}
        <footer className="auth-footer">Your browser can save your password. Home OS remembers your sign-in without storing your password on this device.</footer>
      </section>
    </main>
  );
}
