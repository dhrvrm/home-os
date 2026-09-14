"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "@phosphor-icons/react";
import {
  CURRENCY_MINOR_UNITS,
  DEFAULT_CURRENCY,
  describeSplitFailure,
  formatBasisPoints,
  formatMinorAmount,
  minorAmountInputValue,
  minorUnitOf,
  parseBasisPoints,
  parseMinorAmount,
  resolveShares,
  type Cadence,
  type CadenceUnit,
  type CreateExpenseInput,
  type ExpenseRule,
  type Member,
  type SplitOverride,
  type SplitParticipant,
} from "@/lib/expenses";

type SplitMode = "equal" | "fixed" | "percent";

interface ParticipantRow {
  memberId: string;
  editable: boolean;
  mode: SplitMode;
  fixedText: string;
  percentText: string;
}

interface ExpenseRuleDialogProps {
  rule?: ExpenseRule;
  members: Member[];
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: CreateExpenseInput) => Promise<void>;
}

const CADENCE_UNITS: Array<{ value: CadenceUnit; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const SPLIT_MODES: Array<{ value: SplitMode; label: string }> = [
  { value: "equal", label: "Equal" },
  { value: "fixed", label: "Fixed amount" },
  { value: "percent", label: "Percentage" },
];

export function ExpenseRuleDialog({ rule, members, pending, error, onClose, onSubmit }: ExpenseRuleDialogProps) {
  const [name, setName] = useState(rule?.name ?? "");
  const [currency, setCurrency] = useState(rule?.currency ?? DEFAULT_CURRENCY);
  const [amountText, setAmountText] = useState(() =>
    rule ? minorAmountInputValue(rule.amountMinor, rule.currency) : "",
  );
  const [cadenceUnit, setCadenceUnit] = useState<CadenceUnit>(rule?.cadence.unit ?? "month");
  const [cadenceInterval, setCadenceInterval] = useState(String(rule?.cadence.interval ?? 1));
  const [anchorDate, setAnchorDate] = useState(rule?.cadence.anchorDate ?? todayISODate());
  const [rows, setRows] = useState<ParticipantRow[]>(() => initialRows(rule));
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    const returnFocus = returnFocusRef.current;
    return () => returnFocus?.focus();
  }, []);

  function handleDialogKeys(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !pending) {
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("*") ?? []).filter((element) => (
      element.matches('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function toggleMember(memberId: string, selected: boolean) {
    setRows((current) => selected
      ? [...current, { memberId, editable: true, mode: "equal", fixedText: "", percentText: "" }]
      : current.filter((row) => row.memberId !== memberId));
  }

  function updateRow(memberId: string, change: Partial<ParticipantRow>) {
    setRows((current) => current.map((row) => (row.memberId === memberId ? { ...row, ...change } : row)));
  }

  const totalMinor = parseMinorAmount(amountText, currency);
  const splitParticipants = rows.map((row) => ({ memberId: row.memberId, override: overrideOf(row, currency) }));
  const preview = totalMinor === null
    ? null
    : resolveShares({ totalMinor, minorUnit: minorUnitOf(currency), participants: splitParticipants as SplitParticipant[] });
  const interval = Number(cadenceInterval);
  const validCadence = Number.isSafeInteger(interval) && interval >= 1 && anchorDate !== "";
  const submittable = name.trim() !== "" && totalMinor !== null && validCadence && preview?.ok === true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submittable || totalMinor === null) return;
    const cadence: Cadence = { unit: cadenceUnit, interval, anchorDate };
    await onSubmit({
      name: name.trim(),
      amountMinor: totalMinor,
      currency,
      cadence,
      participants: splitParticipants,
    });
  }

  const selected = new Set(rows.map((row) => row.memberId));
  const title = rule ? `Edit ${rule.name}` : "New recurring expense";

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending) onClose();
    }}>
      <section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="expense-rule-title" onKeyDown={handleDialogKeys}>
        <header className="dialog__header">
          <div><p className="dialog__context">Recurring expense</p><h2 id="expense-rule-title">{title}</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close expense editor" disabled={pending}><X size={20} aria-hidden="true" /></button>
        </header>
        <form className="item-form" onSubmit={submit}>
          <label className="field field--wide">
            <span>Expense name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus required maxLength={120} />
          </label>
          <label className="field">
            <span>Amount</span>
            <input value={amountText} inputMode="decimal" onChange={(event) => setAmountText(event.target.value)} placeholder="0.00" />
          </label>
          <label className="field">
            <span>Currency</span>
            <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {Object.keys(CURRENCY_MINOR_UNITS).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Repeat every</span>
            <input type="number" min="1" step="1" value={cadenceInterval} onChange={(event) => setCadenceInterval(event.target.value)} />
          </label>
          <label className="field">
            <span>Period</span>
            <select value={cadenceUnit} onChange={(event) => setCadenceUnit(event.target.value as CadenceUnit)}>
              {CADENCE_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Starting from</span>
            <input type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
          </label>

          <fieldset className="split-editor field--wide">
            <legend>Participants</legend>
            {members.filter((member) => member.active).map((member) => (
              <div className="split-editor__row" key={member.id}>
                <label className="split-editor__member">
                  <input type="checkbox" checked={selected.has(member.id)} onChange={(event) => toggleMember(member.id, event.target.checked)} />
                  <span>{member.name}</span>
                </label>
                {selected.has(member.id) && <SplitControls
                  memberName={member.name}
                  row={rows.find((row) => row.memberId === member.id)!}
                  currency={currency}
                  onChange={(change) => updateRow(member.id, change)}
                />}
              </div>
            ))}
            {rows.filter((row) => !row.editable).map((row) => (
              <p className="split-editor__inactive" key={row.memberId}>
                {memberName(members, row.memberId)} is no longer in the household but still shares this expense.
              </p>
            ))}
          </fieldset>

          <section className="split-preview field--wide" aria-label="Split preview" aria-live="polite">
            <h3>Preview</h3>
            {preview?.ok && <>
              <ul>
                {preview.shares.map((share) => (
                  <li key={share.memberId}>{memberName(members, share.memberId)} · {formatMinorAmount(share.amountMinor, currency)}</li>
                ))}
              </ul>
              <small>The server resolves the same split.</small>
            </>}
            {preview && !preview.ok && <p className="form-error" role="alert">{describeSplitFailure(preview.reason)}</p>}
            {preview === null && <p>Enter an amount to preview each share.</p>}
          </section>

          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="dialog__actions field--wide">
            <button className="button button--quiet" type="button" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={pending || !submittable}>{pending ? "Saving..." : "Save expense"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function SplitControls({ memberName: label, row, currency, onChange }: {
  memberName: string;
  row: ParticipantRow;
  currency: string;
  onChange: (change: Partial<ParticipantRow>) => void;
}) {
  return (
    <div className="split-editor__controls">
      <label className="field">
        <span>Split for {label}</span>
        <select value={row.mode} onChange={(event) => onChange({ mode: event.target.value as SplitMode })}>
          {SPLIT_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
      </label>
      {row.mode === "fixed" && <label className="field">
        <span>Fixed amount for {label}</span>
        <input value={row.fixedText} inputMode="decimal" onChange={(event) => onChange({ fixedText: event.target.value })} placeholder={currency} />
      </label>}
      {row.mode === "percent" && <label className="field">
        <span>Percentage for {label}</span>
        <input value={row.percentText} inputMode="decimal" onChange={(event) => onChange({ percentText: event.target.value })} placeholder="%" />
      </label>}
    </div>
  );
}

/**
 * An unparseable entry becomes a deliberately invalid override so the preview reports
 * `invalid_override` rather than silently splitting as if no override were set.
 */
function overrideOf(row: ParticipantRow, currency: string): SplitOverride | null {
  if (row.mode === "fixed") {
    return { kind: "fixed", amountMinor: parseMinorAmount(row.fixedText, currency) ?? Number.NaN };
  }
  if (row.mode === "percent") {
    return { kind: "percent", basisPoints: parseBasisPoints(row.percentText) ?? Number.NaN };
  }
  return null;
}

function initialRows(rule?: ExpenseRule): ParticipantRow[] {
  if (!rule) return [];
  return rule.participants.map((participant) => ({
    memberId: participant.memberId,
    editable: participant.memberActive,
    mode: participant.override?.kind === "fixed" ? "fixed" : participant.override?.kind === "percent" ? "percent" : "equal",
    fixedText: participant.override?.kind === "fixed" ? minorAmountInputValue(participant.override.amountMinor, rule.currency) : "",
    percentText: participant.override?.kind === "percent" ? formatBasisPoints(participant.override.basisPoints) : "",
  }));
}

function memberName(members: Member[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}
