"use client";

import { useId, useState } from "react";

export function PasswordField({ label, name, autoComplete, disabled = false, help }: {
  label: string;
  name: string;
  autoComplete: "current-password" | "new-password" | "off";
  disabled?: boolean;
  help?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="field auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input id={id} name={name} type={visible ? "text" : "password"} autoComplete={autoComplete} required minLength={autoComplete === "new-password" ? 12 : undefined} maxLength={128} disabled={disabled} aria-describedby={help ? `${id}-help` : undefined} />
        <button type="button" className="auth-password__toggle" onClick={() => setVisible((value) => !value)} disabled={disabled} aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`} aria-pressed={visible}>{visible ? "Hide" : "Show"}</button>
      </div>
      {help && <small id={`${id}-help`} className="auth-help">{help}</small>}
    </div>
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
