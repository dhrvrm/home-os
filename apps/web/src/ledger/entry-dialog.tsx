"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AuthUser } from "@/lib/auth";
import type { Member } from "@/lib/expenses";
import { Modal, useHouseholdTask, useOnline } from "@/household/ui";
import { errorMessage } from "@/household/api";
import { AmountField } from "./amount-field";
import { checkAttempt, readAttempt, replayAttempt, submitAttempt, type AttemptOutcome, type RetainedAttempt } from "./attempt-state";
import { decimalMoney, formatMoney, parseMoney, previewAllocation, previewItemizedBill } from "./allocation-preview";
import { AdjustmentEditor, ItemEditor, SplitEditor, adjustmentDraft, adjustmentValue, emptyItem, emptySplit, itemDraft, itemValue, memberLabel, splitDraft, splitValue, type AdjustmentDraft, type ItemDraft, type SplitDraft } from "./item-editor";
import type { AcceptedReference, CommandResult, Currency, ExpenseInput, LedgerCommand, LedgerEntry, ResolvedExpense } from "./types";
import "./ledger.css";
export type OnLedgerAccepted = (reference: AcceptedReference, result?: CommandResult) => void | Promise<void>;
interface AttemptView { identity: string; attempt: RetainedAttempt | null; pending: boolean; loaded: boolean; error?: string; refusalError?: Error; accepted?: AcceptedReference }
/** Shared by expense, payment, refund, comment and lifecycle forms. No effect sends money. */
export function useFinancialAttempt(user: AuthUser, onAccepted: OnLedgerAccepted) {
  const identity = `${user.householdId}:${user.id}:${user.role}`;
  const currentIdentity = useRef<string | null>(identity);
  useLayoutEffect(() => { currentIdentity.current = identity; return () => { currentIdentity.current = null; }; }, [identity]);
  const [state, setState] = useState<AttemptView>({ identity, attempt: null, pending: false, loaded: false });
  const patch = useCallback((change: Partial<AttemptView>) => setState(previous => currentIdentity.current !== identity ? previous : ({ ...(previous.identity === identity ? previous : { identity, attempt: null, pending: false, loaded: false }), ...change, identity })), [identity]);
  const task = useHouseholdTask(user); const callback = useRef(onAccepted);
  useLayoutEffect(() => { callback.current = onAccepted; }, [onAccepted]);
  const inFlight = useRef({ identity, active: false });
  const refresh = useCallback(async () => { await task(() => readAttempt(user), value => patch({ attempt: value, loaded: true }), failure => patch({ error: errorMessage(failure), loaded: true })); }, [task, user, patch]);
  useEffect(() => { let active = true; queueMicrotask(() => { if (active) void refresh(); }); const check = () => { if (inFlight.current.identity !== identity || !inFlight.current.active) void refresh(); }; window.addEventListener("focus", check); window.addEventListener("online", check); return () => { active = false; window.removeEventListener("focus", check); window.removeEventListener("online", check); }; }, [refresh, identity]);
  async function perform(action: () => Promise<AttemptOutcome>) {
    if (inFlight.current.identity === identity && inFlight.current.active) return; inFlight.current = { identity, active: true }; patch({ pending: true, error: undefined, refusalError: undefined });
    await task(action, outcome => {
      patch({ pending: false }); if (inFlight.current.identity === identity) inFlight.current.active = false;
      if (outcome.kind === "accepted") {
        patch({ attempt: null, accepted: outcome.reference });
        // Acceptance is final even if navigation or a later balance refresh fails.
        try { void Promise.resolve(callback.current(outcome.reference, outcome.result)).catch(() => patch({ error: "Saved. The latest view could not refresh. Open the recorded entry to check it." })); }
        catch { patch({ error: "Saved. The latest view could not refresh. Open the recorded entry to check it." }); }
      } else if (outcome.kind === "unknown" || outcome.kind === "locked") patch({ attempt: outcome.attempt });
      else if (outcome.kind === "refused") patch({ attempt: null, error: outcome.error.message, refusalError: outcome.error });
      else patch({ attempt: null });
    }, failure => { if (inFlight.current.identity === identity) inFlight.current.active = false; patch({ pending: false, error: errorMessage(failure) }); });
  }
  const current = state.identity === identity ? state : { identity, attempt: null, pending: false, loaded: false };
  return { ...current, refresh, submit: (command: LedgerCommand) => perform(() => submitAttempt(user, command)), check: () => perform(() => checkAttempt(user)), replay: () => perform(() => replayAttempt(user)) };
}
export function AttemptRecovery({ attempt, pending, connected, onCheck, onReplay, members = [], canReplay = true }: { attempt: RetainedAttempt; pending: boolean; connected: boolean; onCheck: () => void; onReplay: () => void; members?: Member[]; canReplay?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [attempt.command.operationId]);
  const command = attempt.command;
  const entry = command.action === "create" || command.action === "correct" ? command.entry : undefined;
  return <section className="ledger-recovery" aria-label="Retained save recovery"><h3 ref={heading} tabIndex={-1}>{attempt.phase === "locked" ? "Recovery locked" : "Save outcome unknown"}</h3><p role="status">{attempt.message ?? "This may already have been recorded. The original save is retained and cannot be edited."}</p><p>Original action · {command.action === "create" ? `Record ${command.entry.kind}` : command.action === "post" ? "Post recurring period" : command.action}</p>
    {entry && <><p>{entry.kind === "payment" ? `Reported payment · ${memberLabel(members, entry.senderId)} to ${memberLabel(members, entry.receiverId)}` : entry.description}</p><p>{entry.date} · {formatMoney(entry.totalMinor, entry.currency)}</p>{entry.kind !== "payment" && <ul>{entry.payers.map(p => <li key={p.memberId}>{memberLabel(members, p.memberId)} paid {formatMoney(p.amountMinor, entry.currency)}</li>)}</ul>}</>}
    {command.action === "comment" && <p>Comment · {command.text}</p>}{command.action === "post" && <p>Period {command.period} · {command.date}. The selected rule/version and payer amounts remain frozen.</p>}
    <p>Checking “not confirmed” does not cancel an outstanding request. Recovery never sends automatically.</p><div className="dialog__actions"><button type="button" className="button button--quiet" disabled={pending || !connected} onClick={onCheck}>Check status</button>{canReplay && <button type="button" className="button button--primary" disabled={pending || !connected} onClick={onReplay}>Replay same save</button>}</div>{!canReplay && <p>Viewers can check their own save status but cannot replay changes.</p>}{!connected && <p>Connect to recover this save.</p>}</section>;
}
interface Draft { date: string; description: string; currency: Currency; category: string; notes: string; mode: "split" | "itemized"; amount: string; payers: { memberId: string; value: string }[]; split: SplitDraft; participantOrder: string[]; items: ItemDraft[]; discount: AdjustmentDraft; tax: AdjustmentDraft; tip: AdjustmentDraft }
export function todayLedgerDate(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function initialDraft(user: AuthUser, entry?: LedgerEntry, duplicate?: boolean, initialCurrency: Currency = "INR"): Draft {
  const input = entry?.intent.kind === "expense" ? entry.intent : undefined; const currency = input?.currency ?? initialCurrency;
  const items = input?.allocation.kind === "itemized" ? input.allocation : undefined;
  return { date: !input || duplicate ? todayLedgerDate() : input.date, description: input?.description ?? "", currency, category: input?.category ?? "", notes: input?.notes ?? "", mode: input?.allocation.kind ?? "split", amount: input ? decimalMoney(input.totalMinor, currency) : "", payers: input ? input.payers.map(p => ({ memberId: p.memberId, value: decimalMoney(p.amountMinor, currency) })) : [{ memberId: user.id, value: "" }], split: input?.allocation.kind === "split" ? splitDraft(input.allocation.split, currency) : emptySplit(), participantOrder: items?.participantOrder ?? [], items: items ? items.items.map(item => itemDraft(item, currency)) : [emptyItem()], discount: adjustmentDraft(items?.discount, currency), tax: adjustmentDraft(items?.tax, currency), tip: adjustmentDraft(items?.tip, currency) };
}
function previewDraft(draft: Draft): ResolvedExpense {
  const payers = draft.payers.map(p => { const amount = parseMoney(p.value, draft.currency); if (amount === null) throw new Error("Enter each payer contribution in the selected currency."); return { memberId: p.memberId, amountMinor: amount }; });
  if (draft.mode === "split") { const totalMinor = parseMoney(draft.amount, draft.currency); if (totalMinor === null || totalMinor === 0) throw new Error("Enter a positive bill amount."); return { totalMinor, payers, shares: previewAllocation(totalMinor, splitValue(draft.split, draft.currency)) }; }
  const itemized = previewItemizedBill({ participantOrder: draft.participantOrder, items: draft.items.map(item => itemValue(item, draft.currency)), discount: adjustmentValue(draft.discount, draft.currency), tax: adjustmentValue(draft.tax, draft.currency), tip: adjustmentValue(draft.tip, draft.currency) });
  return { totalMinor: itemized.totalMinor, shares: itemized.shares, payers, itemized };
}
export interface EntryDialogProps { user: AuthUser; members: Member[]; entry?: LedgerEntry; duplicate?: boolean; initialCurrency?: Currency; onAccepted: OnLedgerAccepted; onClose: () => void; onDirtyChange?: (guarded: boolean) => void }
export function EntryDialog({ user, members, entry: suppliedEntry, duplicate = false, initialCurrency, onAccepted, onClose, onDirtyChange }: EntryDialogProps) {
  // Source refreshes cannot silently rebase a correction or reorder its rounding ties.
  const [entry] = useState(suppliedEntry);
  const [draft, setDraft] = useState(() => initialDraft(user, entry, duplicate, initialCurrency)); const [initial] = useState(() => JSON.stringify(draft));
  const [discard, setDiscard] = useState(false); const [currencyReview, setCurrencyReview] = useState(false);
  const save = useFinancialAttempt(user, (reference, result) => { onDirtyChange?.(false); return onAccepted(reference, result); }); const connected = useOnline();
  const errorSummary = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (save.error) errorSummary.current?.focus(); }, [save.error]);
  const dirty = duplicate || initial !== JSON.stringify(draft);
  const guarded = !save.accepted && (dirty || save.pending || !!save.attempt);
  useEffect(() => { onDirtyChange?.(guarded); return () => onDirtyChange?.(false); }, [guarded, onDirtyChange]);
  useEffect(() => { const prevent = (event: BeforeUnloadEvent) => { if (guarded) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [guarded]);
  function update(patch: Partial<Draft>) { setDraft(current => { if (!patch.items) return { ...current, ...patch }; const selected = Array.from(new Set(patch.items.flatMap(item => item.split.participants.map(p => p.memberId)))); return { ...current, ...patch, participantOrder: [...current.participantOrder.filter(id => selected.includes(id)), ...selected.filter(id => !current.participantOrder.includes(id))] }; }); }
  function close() { if (save.pending) return; if (save.attempt || save.accepted || !dirty) onClose(); else setDiscard(true); }
  let preview: ResolvedExpense | undefined; let invalid: string | undefined;
  try { preview = previewDraft(draft); } catch (error) { invalid = errorMessage(error); }
  const payersMinor = draft.payers.reduce((sum, p) => sum + (parseMoney(p.value, draft.currency) ?? 0), 0);
  const parties = new Set([...draft.payers.map(p => p.memberId), ...(preview?.shares.map(p => p.memberId) ?? (draft.mode === "split" ? draft.split.participants.map(p => p.memberId) : draft.items.flatMap(item => item.split.participants.map(p => p.memberId))))]);
  const historical = !duplicate && entry ? new Set([...entry.payers, ...entry.shares].map(p => p.memberId)) : new Set<string>();
  const departed = [...parties].some(id => !members.some(m => m.id === id && m.active) && !historical.has(id));
  const realDate = /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && !draft.date.startsWith("0000") && (() => { try { return new Date(`${draft.date}T00:00:00.000Z`).toISOString().slice(0, 10) === draft.date; } catch { return false; } })();
  const problem = departed ? "Replace or remove departed people before saving a new expense." : parties.size > 12 ? "Choose at most 12 distinct payers and beneficiaries." : !draft.description.trim() ? "Enter a description." : !realDate ? "Enter a real calendar date." : draft.payers.length === 0 ? "Choose at least one payer." : invalid ?? (preview && payersMinor !== preview.totalMinor ? "Payer contributions must equal the bill total." : currencyReview ? "Review the amounts after changing currency." : undefined);
  const disabled = save.pending || user.role === "viewer";
  async function submit() {
    if (problem || !preview || disabled || !connected || !save.loaded) return;
    const entryInput: ExpenseInput = { kind: "expense", date: draft.date, description: draft.description.trim(), currency: draft.currency, totalMinor: preview.totalMinor, ...(draft.category.trim() ? { category: draft.category.trim() } : {}), ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}), payers: preview.payers, allocation: draft.mode === "split" ? { kind: "split", split: splitValue(draft.split, draft.currency) } : { kind: "itemized", participantOrder: draft.participantOrder, items: draft.items.map(item => itemValue(item, draft.currency)), discount: adjustmentValue(draft.discount, draft.currency), tax: adjustmentValue(draft.tax, draft.currency), tip: adjustmentValue(draft.tip, draft.currency) } };
    await save.submit(entry && !duplicate ? { operationId: crypto.randomUUID(), action: "correct", entryId: entry.id, expectedVersion: entry.version, entry: entryInput } : { operationId: crypto.randomUUID(), action: "create", entry: entryInput });
  }
  const payerPeople = [...members, ...draft.payers.filter(p => !members.some(m => m.id === p.memberId)).map(p => ({ id: p.memberId, name: p.memberId, active: false }))];
  return <Modal title={duplicate ? "Duplicate expense · unsaved" : entry ? "Correct expense" : "Add expense"} pending={save.pending} onClose={close}>
    <div className="ledger-composer">
    {save.error && <p ref={errorSummary} tabIndex={-1} className="form-error" role="alert">{save.error}</p>}
    {!save.loaded ? <p role="status">Checking for a retained save…</p> : save.accepted ? <><p role="status">Expense recorded.</p><button type="button" className="button button--quiet" onClick={onClose}>Close recorded expense</button></> : save.attempt ? <><AttemptRecovery attempt={save.attempt} pending={save.pending} connected={connected} onCheck={() => void save.check()} onReplay={() => void save.replay()} members={members} canReplay={user.role !== "viewer"} /><button type="button" className="button button--quiet" disabled={save.pending} onClick={onClose}>Close recovery · keep retained save</button></> : discard ? <section aria-label="Discard draft"><h3>Discard this unsaved draft?</h3><p>Your entered bill has not been saved.</p><div className="dialog__actions"><button type="button" className="button button--quiet" autoFocus onClick={() => setDiscard(false)}>Keep editing</button><button type="button" className="button button--primary" onClick={onClose}>Discard draft</button></div></section> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="ledger-unsaved">Unsaved{duplicate ? ` · copied from ${entry?.intent.kind === "expense" ? entry.intent.description : "expense"}` : ""}</p>
      {user.role === "viewer" && <p>Viewers can inspect shared finances but cannot record changes.</p>}{!connected && <p role="status">You’re offline. Connect to save; this draft stays unsaved.</p>}
      <fieldset className="ledger-fields" disabled={disabled}>
        <label className="field"><span>Description</span><input autoFocus maxLength={160} required value={draft.description} onChange={event => update({ description: event.target.value })} /></label>
        <div className="ledger-columns"><label className="field"><span>Date</span><input type="date" required value={draft.date} onChange={event => update({ date: event.target.value })} /></label><label className="field"><span>Currency</span><select value={draft.currency} onChange={event => { update({ currency: event.target.value as Currency }); setCurrencyReview(true); }}>{["INR", "USD", "EUR", "GBP", "JPY"].map(currency => <option key={currency}>{currency}</option>)}</select></label></div>
        {currencyReview && <section className="ledger-notice" role="status"><p>Currency changed. Amounts keep their entered major-unit values; no exchange conversion is performed. Review precision in every amount.</p><button type="button" className="button button--quiet" onClick={() => setCurrencyReview(false)}>I reviewed the amounts</button></section>}
        <label className="field"><span>Amount mode</span><select value={draft.mode} onChange={event => update({ mode: event.target.value as Draft["mode"] })}><option value="split">Whole bill</option><option value="itemized">Itemized bill</option></select></label><small>Switching modes keeps both sets of unsaved input; only the selected mode is submitted.</small>
        {draft.mode === "split" ? <AmountField label="Bill amount" value={draft.amount} currency={draft.currency} onChange={amount => update({ amount })} /> : <><ItemEditor value={draft.items} currency={draft.currency} members={members} onChange={items => update({ items })} /><div className="ledger-adjustments">{(["discount", "tax", "tip"] as const).map(key => <AdjustmentEditor key={key} label={key[0].toUpperCase() + key.slice(1)} value={draft[key]} currency={draft.currency} onChange={value => update({ [key]: value })} />)}</div></>}
        <fieldset className="ledger-group"><legend>Who paid</legend>{payerPeople.filter(m => m.active || draft.payers.some(p => p.memberId === m.id)).map(member => { const row = draft.payers.find(p => p.memberId === member.id); return <div key={member.id} className="ledger-person"><label className="ledger-person__name"><input type="checkbox" aria-label={`Payer ${member.name}`} checked={!!row} onChange={event => update({ payers: event.target.checked ? [...draft.payers, { memberId: member.id, value: "" }] : draft.payers.filter(p => p.memberId !== member.id) })} />{member.name}{!member.active ? " · departed" : ""}</label>{row && <AmountField label={`Paid by ${member.name}`} value={row.value} currency={draft.currency} onChange={value => update({ payers: draft.payers.map(p => p.memberId === member.id ? { ...p, value } : p) })} allowZero />}</div>; })}<p>Payer total · {formatMoney(payersMinor, draft.currency)}</p><p>Payer difference · {formatMoney((preview?.totalMinor ?? 0) - payersMinor, draft.currency)}</p></fieldset>
        {draft.mode === "split" && <SplitEditor label="Who shares" value={draft.split} currency={draft.currency} members={members} onChange={split => update({ split })} />}
        <label className="field"><span>Category</span><input maxLength={200} value={draft.category} onChange={event => update({ category: event.target.value })} /></label><label className="field"><span>Notes</span><textarea maxLength={2000} value={draft.notes} onChange={event => update({ notes: event.target.value })} /></label>
      </fieldset>
      <section className="ledger-review" aria-label="Expense review"><h3>Review · {draft.currency}</h3>{preview && <><p>Total · {formatMoney(preview.totalMinor, draft.currency)}</p>{preview.itemized && <><p>Subtotal {formatMoney(preview.itemized.subtotalMinor, draft.currency)} − discount {formatMoney(preview.itemized.discountMinor, draft.currency)} + tax {formatMoney(preview.itemized.taxMinor, draft.currency)} + tip {formatMoney(preview.itemized.tipMinor, draft.currency)}</p><small>Discount comes first. Tax and tip independently use the discounted subtotal. Percentage adjustments round once, then allocate by recorded order.</small>{preview.itemized.items.map((item, index) => <p key={index}>{item.label} · {item.quantity} × {formatMoney(item.unitPriceMinor, draft.currency)} = {formatMoney(item.totalMinor, draft.currency)}</p>)}</>}{preview.shares.map(share => { const breakdown = preview.itemized?.breakdown.find(row => row.memberId === share.memberId); return <div className="ledger-money-row" key={share.memberId}><span>{memberLabel(members, share.memberId)}</span><output aria-label={`Share for ${memberLabel(members, share.memberId)}`}>{formatMoney(share.amountMinor, draft.currency)}</output>{breakdown && <small>Base {formatMoney(breakdown.baseMinor, draft.currency)} − discount {formatMoney(breakdown.discountMinor, draft.currency)} + tax {formatMoney(breakdown.taxMinor, draft.currency)} + tip {formatMoney(breakdown.tipMinor, draft.currency)}</small>}</div>; })}</>}{problem && <p className="form-error" role="status">{problem}</p>}<small>Exact preview only. The server revalidates participants and allocations when saving.</small></section>
      <footer className="dialog__actions"><button className="button button--quiet" type="button" disabled={save.pending} onClick={close}>Cancel</button><button className="button button--primary" type="submit" disabled={disabled || !connected || !!problem || !save.loaded}>{save.pending ? "Saving…" : entry && !duplicate ? "Save correction" : "Save expense"}</button></footer>
    </form>}
    </div>
  </Modal>;
}
