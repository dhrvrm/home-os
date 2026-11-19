"use client";
import { useState } from "react";
import { AmountField } from "./amount-field";
import { decimalMoney, formatMoney, parseMoney } from "./allocation-preview";
import { FinancialDialog, validDate, type FinancialDialogProps } from "./payment-dialog";
import { todayLedgerDate } from "./entry-dialog";
import type { LedgerEntry, RefundCapacity, LedgerCommand, RefundInput } from "./types";
export function RefundDialog({ original, capacity, entry, onRefreshCapacity, ...props }: FinancialDialogProps & {
    original: LedgerEntry;
    capacity: RefundCapacity;
    entry?: LedgerEntry;
    onRefreshCapacity?: () => void;
}) {
    const [observed] = useState(entry);
    const source = observed?.intent.kind === "refund" ? observed.intent : undefined;
    const [currency] = useState(original.intent.currency);
    const [openedOriginal] = useState(original);
    const [openedCapacity] = useState(capacity);
    const sourceChanged = original.intent.currency !== currency;
    const shownCapacity = sourceChanged ? openedCapacity : capacity;
    const [amount, setAmount] = useState(source ? decimalMoney(source.totalMinor, currency) : "");
    const [date, setDate] = useState(source?.date ?? todayLedgerDate());
    const [description, setDescription] = useState(source?.description ?? "Refund");
    const [notes, setNotes] = useState(source?.notes ?? "");
    const [payers, setPayers] = useState<Record<string, string>>(Object.fromEntries(original.payers.map(p => [p.memberId, decimalMoney(source?.payers.find(v => v.memberId === p.memberId)?.amountMinor ?? 0, currency)])));
    const [shares, setShares] = useState<Record<string, string>>(Object.fromEntries(original.shares.map(p => [p.memberId, decimalMoney(source?.shares.find(v => v.memberId === p.memberId)?.amountMinor ?? 0, currency)])));
    const snapshot = JSON.stringify({ amount, date, description, notes, payers, shares });
    const [initial] = useState(snapshot);
    const totalMinor = parseMoney(amount, currency);
    const values = (rows: Record<string, string>) => Object.entries(rows).map(([memberId, value]) => ({ memberId, amountMinor: parseMoney(value, currency) ?? -1 }));
    const ps = values(payers);
    const ss = values(shares);
    const limitFor = (id: string, side: "payers" | "shares") => (shownCapacity[side].find(p => p.memberId === id)?.remainingMinor ?? 0) + (source?.[side].find(p => p.memberId === id)?.amountMinor ?? 0);
    const problem = sourceChanged ? "The original currency changed. Your amounts remain in the opened currency. Close and reopen this refund to deliberately review the current original before saving." : !capacity.available ? "The original expense is not effective. Refresh it before recording a refund." : !totalMinor ? "Enter a positive refund amount." : totalMinor > capacity.remainingMinor + (source?.totalMinor ?? 0) ? "Refund exceeds remaining original capacity. Refresh capacity for review; your input is retained." : !description.trim() ? "Enter a description." : !validDate(date) ? "Enter a real date." : ps.some(p => p.amountMinor < 0 || p.amountMinor > limitFor(p.memberId, "payers")) || ss.some(p => p.amountMinor < 0 || p.amountMinor > limitFor(p.memberId, "shares")) ? "Each returned amount must fit its person's remaining capacity." : ps.reduce((a, p) => a + p.amountMinor, 0) !== totalMinor || ss.reduce((a, p) => a + p.amountMinor, 0) !== totalMinor ? "Returned contributions and credited consumption must each equal the refund amount." : undefined;
    const fact: RefundInput = { kind: "refund", expenseId: original.id, currency, date, description: description.trim(), totalMinor: totalMinor ?? 0, notes: notes.trim() || undefined, payers: ps, shares: ss };
    const command: LedgerCommand = observed ? { operationId: "", action: "correct", entryId: observed.id, expectedVersion: observed.version, entry: fact } : { operationId: "", action: "create", entry: fact };
    return <FinancialDialog {...props} title={observed ? "Correct linked refund" : "Record linked refund"} dirty={snapshot !== initial} command={command} problem={problem} saveLabel={observed ? "Save correction" : "Record refund"}>
    <p>Original expense · {openedOriginal.intent.kind !== "payment" ? openedOriginal.intent.description : openedOriginal.id} · {formatMoney(openedOriginal.intent.totalMinor, currency)}</p>
    <p>Remaining refund capacity · {formatMoney(shownCapacity.remainingMinor, currency)}. A refund reverses original contributions and allocated consumption.</p>
    <button className="button button--quiet" type="button" onClick={onRefreshCapacity}>Refresh original and capacity · keep input</button>
    <label className="field">
    <span>Description</span>
    <input maxLength={160} value={description} onChange={e => setDescription(e.target.value)}/>
    </label>
    <AmountField label="Refund amount" currency={currency} value={amount} onChange={setAmount}/>
    <label className="field">
    <span>Refund date</span>
    <input type="date" value={date} onChange={e => setDate(e.target.value)}/>
    </label>{([['payers', 'Returned to original payers', payers, setPayers], ['shares', 'Credited beneficiaries', shares, setShares]] as const).map(([side, label, rows, set]) => <fieldset className="ledger-group" key={side}>
        <legend>{label}</legend>{Object.entries(rows).map(([id, value]) => <div key={id}>
            <AmountField label={`${label}: ${props.members.find(m => m.id === id)?.name ?? id}`} currency={currency} value={value} onChange={v => set(old => ({ ...old, [id]: v }))} allowZero/>
            <small>Remaining · {formatMoney(limitFor(id, side), currency)}</small>
            </div>)}</fieldset>)}<section className="ledger-review" aria-label="Refund effect">
    <h3>Refund effect · {currency}</h3>{ps.filter(p => p.amountMinor >= 0).map(p => <p key={`payer:${p.memberId}`}>Returned contribution · {props.members.find(m => m.id === p.memberId)?.name ?? p.memberId} net decreases by {formatMoney(p.amountMinor, currency)}</p>)}{ss.filter(p => p.amountMinor >= 0).map(p => <p key={`share:${p.memberId}`}>Credited consumption · {props.members.find(m => m.id === p.memberId)?.name ?? p.memberId} net increases by {formatMoney(p.amountMinor, currency)}</p>)}</section>
    <label className="field">
    <span>Notes</span>
    <textarea maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)}/>
    </label>
    </FinancialDialog>;
}
