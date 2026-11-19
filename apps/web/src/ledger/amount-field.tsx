"use client";
import { useId, useRef, useState } from "react";
import { calculateAmount } from "./calculator";
import { parseMoney } from "./allocation-preview";
import type { Currency } from "./types";
import "./ledger.css";
export interface AmountFieldProps { label: string; value: string; currency: Currency; onChange: (value: string) => void; disabled?: boolean; allowZero?: boolean; required?: boolean }
/** One inline calculator, inside the parent's focus scope. Apply changes only text. */
export function AmountField({ label, value, currency, onChange, disabled, allowZero = false, required = false }: AmountFieldProps) {
  const id = useId(); const [open, setOpen] = useState(false); const [expression, setExpression] = useState("");
  const trigger = useRef<HTMLButtonElement>(null); const expressionRef = useRef<HTMLInputElement>(null);
  const result = calculateAmount(expression, currency);
  const applicable = result.ok && (allowZero ? result.amountMinor >= 0 : result.amountMinor > 0);
  const invalid = value !== "" && (parseMoney(value, currency) === null || !allowZero && parseMoney(value, currency) === 0);
  function close() { setOpen(false); trigger.current?.focus(); }
  return <div className="field ledger-amount">
    <label htmlFor={id}>{label}</label>
    <div className="ledger-amount__input"><input id={id} value={value} inputMode="decimal" required={required} disabled={disabled} onChange={event => onChange(event.target.value)} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} /><button ref={trigger} className="button button--quiet" type="button" disabled={disabled} aria-expanded={open} aria-label={`Calculate ${label}`} onClick={() => { setExpression(value); setOpen(true); }}>Calculate</button></div>
    {invalid && <small id={`${id}-error`} className="form-error">Enter {allowZero ? "a nonnegative" : "a positive"} {currency} amount with {currency === "JPY" ? "no" : "at most two"} decimal places.</small>}
    {open && <section className="ledger-calculator" aria-label={`Calculator for ${label}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } if (event.key === "Enter" && event.target === expressionRef.current) { event.preventDefault(); event.stopPropagation(); } }}>
      <label htmlFor={`${id}-expression`}>Calculation for {label}</label>
      <input id={`${id}-expression`} ref={expressionRef} value={expression} maxLength={128} autoFocus disabled={disabled} onChange={event => setExpression(event.target.value)} />
      <div className="ledger-calculator__operators" aria-label="Calculation operators">{["+", "-", "*", "/", "(", ")", "%"].map(operator => <button key={operator} type="button" className="button button--quiet" disabled={disabled} aria-label={`Insert ${operator}`} onClick={() => { const input = expressionRef.current; const start = input?.selectionStart ?? expression.length; const end = input?.selectionEnd ?? start; setExpression(expression.slice(0, start) + operator + expression.slice(end)); input?.focus(); }}>{operator}</button>)}</div>
      <p role="status">{result.ok ? `${currency} ${result.display} · rounded for this currency` : result.error}</p>
      {!applicable && result.ok && <small className="form-error">The applied amount must be {allowZero ? "zero or positive" : "positive"}.</small>}
      <div className="dialog__actions"><button type="button" className="button button--quiet" onClick={close}>Cancel calculation</button><button type="button" className="button button--primary" disabled={disabled || !applicable} onClick={() => { if (result.ok && applicable) { onChange(result.display); close(); } }}>Apply{result.ok ? ` ${currency} ${result.display}` : ""}</button></div>
    </section>}
  </div>;
}
