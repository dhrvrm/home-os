"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, House, UsersThree } from "@phosphor-icons/react";
import { organizationSlug, postAuth, type HomeSessionContext } from "@/lib/auth-client";

export function OrganizationOnboarding({ session, onReady }: {
  session: HomeSessionContext;
  onReady: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organizations = session.organizations ?? [];

  async function select(organizationId: string) {
    setPending(true);
    setError(null);
    try {
      await postAuth("/api/auth/organization/set-active", { organizationId });
      await onReady();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The home could not be selected.");
      setPending(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      const organization = await postAuth<{ id: string }>("/api/auth/organization/create", {
        name: trimmed,
        slug: organizationSlug(trimmed),
      });
      await postAuth("/api/auth/organization/set-active", { organizationId: organization.id });
      await onReady();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "The home could not be created.");
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card auth-card--wide" aria-labelledby="home-setup-title">
        <div className="auth-brand"><span><House size={22} weight="fill" /></span>Home OS</div>
        <p className="auth-eyebrow">Welcome, {session.user?.name}</p>
        <h1 id="home-setup-title">Choose the home you want to open.</h1>
        {organizations.length > 0 && <div className="home-choice-list">
          {organizations.map((organization) => (
            <button type="button" key={organization.id} onClick={() => void select(organization.id)} disabled={pending}>
              <span><UsersThree size={20} weight="duotone" /></span>
              <span><strong>{organization.name}</strong><small>Open shared inventory</small></span>
              <ArrowRight size={18} />
            </button>
          ))}
        </div>}
        <form className="create-home-form" onSubmit={(event) => void create(event)}>
          <label htmlFor="home-name">{organizations.length ? "Or create another home" : "Name your first home"}</label>
          <div><input id="home-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Verma Home or Flat 12" maxLength={80} /><button className="button button--primary" disabled={pending || !name.trim()}>{pending ? "Creating…" : "Create home"}</button></div>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
