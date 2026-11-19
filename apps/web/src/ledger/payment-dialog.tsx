"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthUser } from "@/lib/auth";
import type { Member } from "@/lib/expenses";
import { Modal, useOnline } from "@/household/ui";
import { AmountField } from "./amount-field";
import { decimalMoney, formatMoney, parseMoney } from "./allocation-preview";
import { AttemptRecovery, todayLedgerDate, useFinancialAttempt, type OnLedgerAccepted } from "./entry-dialog";
import type { LedgerCommand, LedgerEntry, RepaymentSuggestion, Currency, PaymentInput } from "./types";
export interface FinancialDialogProps {
    user: AuthUser;
    members: Member[];
    onAccepted: OnLedgerAccepted;
    onClose: () => void;
    onDirtyChange?: (dirty: boolean) => void;
}
export function FinancialDialog({ title, user, members, onAccepted, onClose, onDirtyChange, dirty, command, children, problem, saveLabel = "Record", refusalContent }: FinancialDialogProps & {
    title: string;
    dirty: boolean;
    command?: Omit<LedgerCommand, "operationId"> | LedgerCommand;
    children: ReactNode;
    problem?: string;
    saveLabel?: string;
    refusalContent?: (error: Error) => ReactNode;
}) {
    const [discard, setDiscard] = useState(false);
    const connected = useOnline();
    const save = useFinancialAttempt(user, (reference, result) => { onDirtyChange?.(false); return onAccepted(reference, result); });
    const errorSummary = useRef<HTMLParagraphElement>(null);
    useEffect(() => { if (save.error)
        errorSummary.current?.focus(); }, [save.error]);
    const guarded = !save.accepted && (dirty || save.pending || !!save.attempt);
    useEffect(() => { onDirtyChange?.(guarded); return () => onDirtyChange?.(false); }, [onDirtyChange, guarded]);
    useEffect(() => { const prevent = (event: BeforeUnloadEvent) => { if (guarded) {
        event.preventDefault();
        event.returnValue = "";
    } }; window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent); }, [guarded]);
    const close = () => { if (save.pending)
        return; if (!dirty || save.attempt || save.accepted)
        onClose();
    else
        setDiscard(true); };
    return <Modal title={title} pending={save.pending} onClose={close}>
    <div className="ledger-composer">{save.error && <p ref={errorSummary} className="form-error" role="alert" tabIndex={-1}>{save.error}</p>}{save.refusalError && refusalContent?.(save.refusalError)}{!save.loaded ? <p role="status">Checking retained save…</p> : save.accepted ? <>
        <p role="status">Recorded. The accepted entry is available from Expenses.</p>
        <button type="button" onClick={onClose}>Close</button>
        </> : save.attempt ? <>
        <AttemptRecovery attempt={save.attempt} pending={save.pending} connected={connected} onCheck={() => void save.check()} onReplay={() => void save.replay()} members={members} canReplay={user.role !== "viewer"}/>
        <button type="button" disabled={save.pending} className="button button--quiet" onClick={onClose}>Close recovery · keep retained save</button>
        </> : discard ? <section>
        <h3>Discard unsaved draft?</h3>
        <button type="button" className="button button--quiet" autoFocus onClick={() => setDiscard(false)}>Keep editing</button>
        <button type="button" className="button button--primary" onClick={onClose}>Discard draft</button>
        </section> : <form onSubmit={event => { event.preventDefault(); if (command && !problem && connected && user.role !== "viewer")
            void save.submit({ ...command, operationId: crypto.randomUUID() } as LedgerCommand); }}>
        <p className="ledger-unsaved">Unsaved</p>{!connected && <p role="status">Connect to record this change. Money is never queued for later sending.</p>}{user.role === "viewer" && <p>Viewers can inspect finances but cannot record changes.</p>}<fieldset className="ledger-fields" disabled={save.pending || user.role === "viewer"}>{children}</fieldset>{problem && <p role="status">{problem}</p>}<footer className="dialog__actions">
        <button type="button" className="button button--quiet" onClick={close}>Cancel</button>
        <button type="submit" className="button button--primary" disabled={!command || !!problem || !connected || save.pending || user.role === "viewer"}>{save.pending ? "Saving…" : saveLabel}</button>
        </footer>
        </form>}</div>
    </Modal>;
}
export function PaymentDialog({ suggestion, entry, defaultCurrency = "INR", ...props }: FinancialDialogProps & {
    suggestion?: RepaymentSuggestion;
    entry?: LedgerEntry;
    defaultCurrency?: Currency;
}) {
    const [observed] = useState(entry);
    const input = observed?.intent.kind === "payment" ? observed.intent : undefined;
    const [senderId, setSender] = useState(input?.senderId ?? suggestion?.senderId ?? props.user.id);
    const [receiverId, setReceiver] = useState(input?.receiverId ?? suggestion?.receiverId ?? props.members.find(m => m.id !== props.user.id)?.id ?? "");
    const [currency, setCurrency] = useState<Currency>(input?.currency ?? suggestion?.currency ?? defaultCurrency);
    const [amount, setAmount] = useState(input ? decimalMoney(input.totalMinor, input.currency) : suggestion ? decimalMoney(suggestion.amountMinor, suggestion.currency) : "");
    const [date, setDate] = useState(input?.date ?? todayLedgerDate());
    const [method, setMethod] = useState(input?.method ?? "");
    const [reference, setReference] = useState(input?.reference ?? "");
    const [notes, setNotes] = useState(input?.notes ?? "");
    const [review, setReview] = useState(false);
    const [initial] = useState(() => JSON.stringify({ senderId, receiverId, currency, amount, date, method, reference, notes }));
    const dirty = initial !== JSON.stringify({ senderId, receiverId, currency, amount, date, method, reference, notes });
    const totalMinor = parseMoney(amount, currency);
    const problem = !totalMinor ? "Enter a positive reported amount." : senderId === receiverId || !senderId || !receiverId ? "Choose different sender and receiver." : !method.trim() ? "Enter the payment method." : !validDate(date) ? "Enter a real date." : review ? "Review amounts after changing currency; no conversion is performed." : undefined;
    const fact: PaymentInput = { kind: "payment", senderId, receiverId, currency, totalMinor: totalMinor ?? 0, date, method: method.trim(), reference: reference.trim() || undefined, notes: notes.trim() || undefined };
    const command: LedgerCommand = observed ? { operationId: "", action: "correct", entryId: observed.id, expectedVersion: observed.version, entry: fact } : { operationId: "", action: "create", entry: fact };
    const name = (id: string) => props.members.find(m => m.id === id)?.name ?? id;
    return <FinancialDialog {...props} title={observed ? "Correct recorded payment" : "Record payment"} dirty={dirty} command={command} problem={problem} saveLabel={observed ? "Save correction" : "Record payment"}>
    <p>This records a payment you report. Home OS does not transfer money.</p>{suggestion && <p>Suggested amount was {formatMoney(suggestion.amountMinor, suggestion.currency)}. Balances may change; your entered fact stays editable and may be partial or reverse a balance.</p>}{([['Sender', senderId, setSender], ['Receiver', receiverId, setReceiver]] as const).map(([label, value, set]) => <label className="field" key={label}>
        <span>{label}</span>
        <select value={value} onChange={e => set(e.target.value)}>{props.members.map(m => <option value={m.id} key={m.id}>{m.name}{!m.active ? " · departed" : ""}</option>)}</select>
        </label>)}<label className="field">
    <span>Currency</span>
    <select value={currency} onChange={e => { setCurrency(e.target.value as Currency); setReview(true); }}>{["INR", "USD", "EUR", "GBP", "JPY"].map(c => <option key={c}>{c}</option>)}</select>
    </label>{review && <button type="button" className="button button--quiet" onClick={() => setReview(false)}>I reviewed the amounts</button>}<AmountField label="Reported amount" value={amount} currency={currency} onChange={setAmount}/>
    <label className="field">
    <span>Payment date</span>
    <input type="date" value={date} onChange={e => setDate(e.target.value)}/>
    </label>
    <label className="field">
    <span>Method</span>
    <input maxLength={200} value={method} onChange={e => setMethod(e.target.value)}/>
    </label>
    <label className="field">
    <span>Reference</span>
    <input maxLength={200} value={reference} onChange={e => setReference(e.target.value)}/>
    </label>
    <label className="field">
    <span>Notes</span>
    <textarea maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)}/>
    </label>{totalMinor !== null && <section aria-label="Payment effect" className="ledger-review">
        <h3>Reported payment effect</h3>
        <p>{name(senderId)} sends {formatMoney(totalMinor, currency)} to {name(receiverId)}.</p>
        <p>Sender net increases by {formatMoney(totalMinor, currency)}; receiver net decreases by the same amount.</p>
        </section>}</FinancialDialog>;
}
export function validDate(date: string) { try {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith("0000") && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
catch {
    return false;
} }
