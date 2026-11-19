"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { APIError } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";
import type { Member } from "@/lib/expenses";
import { useHouseholdTask, ResourceState } from "@/household/ui";
import type { SavedCopy } from "@/household/cache";
import { ledgerQuery, ledgerRead } from "./api";
import { formatMoney } from "./allocation-preview";
import type { Currency, LedgerPage, MemberBalance, RepaymentSuggestion, BalanceTotal } from "./types";
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
export function validPage<T>(valid: (row: unknown) => row is T) { return (value: unknown): value is LedgerPage<T> => object(value) && integer(value.revision) && value.revision >= 0 && (value.nextCursor === null || typeof value.nextCursor === "string") && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(valid); }
export const validBalance = (value: unknown): value is MemberBalance => object(value) && typeof value.memberId === "string" && typeof value.displayName === "string" && typeof value.active === "boolean" && ["INR", "USD", "EUR", "GBP", "JPY"].includes(String(value.currency)) && [value.paidMinor, value.shareMinor, value.sentMinor, value.receivedMinor, value.netMinor].every(integer);
const validBalanceTotal=(v:unknown):v is BalanceTotal=>object(v)&&["INR","USD","EUR","GBP","JPY"].includes(String(v.currency))&&[v.paidMinor,v.shareMinor,v.sentMinor,v.receivedMinor,v.netMinor].every(integer);
const balancePage=(v:unknown):v is LedgerPage<MemberBalance>&{totals:BalanceTotal[]}=>validPage(validBalance)(v)&&object(v)&&Array.isArray(v.totals)&&v.totals.length<=5&&v.totals.every(validBalanceTotal);
const repaymentPage = validPage((v): v is RepaymentSuggestion => object(v) && typeof v.senderId === "string" && typeof v.receiverId === "string" && integer(v.amountMinor) && v.amountMinor > 0 && ["INR", "USD", "EUR", "GBP", "JPY"].includes(String(v.currency)));
export function useLedgerRead<T>(user: AuthUser, path: string, valid: (value: unknown) => value is T, kind: "query" | "detail" = "query"): {
    loading: boolean;
    copy?: SavedCopy<T>;
    error?: string;
    refresh: () => Promise<void>;
} {
    const identity = `${user.householdId}:${user.id}:${user.role}:${path}`;
    const [state, setState] = useState<{
        identity: string;
        loading: boolean;
        copy?: SavedCopy<T>;
        error?: string;
    }>({ identity, loading: true });
    const task = useHouseholdTask(user);
    const sequence = useRef(0);
    const refresh = useCallback(async () => { const request = ++sequence.current; setState(old => ({ identity, loading: true, ...(old.identity === identity ? { copy: old.copy } : {}) })); await task(() => ledgerRead(user, path, valid, kind), copy => { if (sequence.current === request)
        setState({ identity, loading: false, copy }); }, error => { if (sequence.current === request)
        setState(old => ({ identity, loading: false, copy: error instanceof APIError && ["forbidden", "unauthorized", "session_changed"].includes(error.code) ? undefined : old.identity === identity ? old.copy : undefined, error: error instanceof Error ? error.message : "Financial information could not be loaded." })); }); }, [task, user, identity, path, valid, kind]);
    useEffect(() => { let active = true; const requests = sequence; queueMicrotask(() => { if (active)
        void refresh(); }); return () => { active = false; requests.current++; }; }, [refresh]);
    return { ...(state.identity === identity ? state : { loading: true }), refresh };
}
export function balanceWords(net: number, currency: Currency, personal = false) { return net === 0 ? "Settled" : `${personal ? "You " : ""}${net > 0 ? personal ? "are owed" : "is owed" : personal ? "owe" : "owes"} ${formatMoney(Math.abs(net), currency)}`; }
export function BalancesView({ user, members, currency, cursor, onCursor, onStatement, onPayment }: {
    user: AuthUser;
    members: Member[];
    currency: Currency;
    cursor?: string;
    onCursor: (cursor?: string) => void;
    onStatement: (id: string) => void;
    onPayment: (suggestion?: RepaymentSuggestion) => void;
}) {
    const balances = useLedgerRead(user, ledgerQuery("/balances", { currency, cursor, limit: 25 }), balancePage);
    const [repaymentCursor, setRepaymentCursor] = useState<string>();
    const repayments = useLedgerRead(user, ledgerQuery("/repayments", { currency, cursor: repaymentCursor, limit: 25 }), repaymentPage);
    const name = (id: string) => members.find(m => m.id === id)?.name ?? id;
    return <section aria-label="Household balances">
    <h2>Balances · {currency}</h2>
    <p>Complete current contribution, consumption and recorded payment effects. Positive balances are owed to the person.</p>
    <ResourceState {...balances} retry={() => void balances.refresh()}/>{balances.error&&!balances.copy&&cursor&&<PageControls failed cursor={cursor} next={null} onCursor={onCursor}/>}
    {balances.copy && <>
        <p>Accepted financial revision {balances.copy.data.revision}</p><section aria-label="Complete household currency totals"><h3>Complete household totals</h3>{balances.copy.data.totals.map(total=><dl className="ledger-breakdown" key={total.currency}><div><dt>Contributed · {total.currency}</dt><dd>{formatMoney(total.paidMinor,total.currency)}</dd></div><div><dt>Allocated consumption</dt><dd>{formatMoney(total.shareMinor,total.currency)}</dd></div><div><dt>Payments sent</dt><dd>{formatMoney(total.sentMinor,total.currency)}</dd></div><div><dt>Payments received</dt><dd>{formatMoney(total.receivedMinor,total.currency)}</dd></div><div><dt>Net across household</dt><dd>{formatMoney(total.netMinor,total.currency)}</dd></div></dl>)}</section>{balances.copy.data.items.length === 0 && <p>No balances in this currency.</p>}{balances.copy.data.items.map(row => <article key={row.memberId} className="ledger-balance">
            <h3>{row.displayName}{!row.active ? " · departed" : ""}</h3>
            <strong>{balanceWords(row.netMinor, currency)}</strong>
            <dl className="ledger-breakdown">{[["Contributed", row.paidMinor], ["Allocated consumption", row.shareMinor], ["Payments sent", row.sentMinor], ["Payments received", row.receivedMinor]].map(([label, amount]) => <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{formatMoney(Number(amount), currency)}</dd>
                </div>)}</dl>
            <button className="button button--quiet" type="button" onClick={() => onStatement(row.memberId)}>Statement for {row.displayName}</button>
            </article>)}<PageControls cursor={cursor} next={balances.copy.data.nextCursor} onCursor={onCursor}/>
        </>}
    <header className="ledger-toolbar">
    <h3>Suggested repayments</h3>{user.role !== "viewer" && <button type="button" className="button button--primary" onClick={() => onPayment()}>Record payment</button>}</header>
    <p>A possible way to settle net balances. These suggestions do not execute transfers or identify original counterparty debt.</p>
    <ResourceState {...repayments} retry={() => void repayments.refresh()}/>{repayments.error&&!repayments.copy&&repaymentCursor&&<PageControls failed cursor={repaymentCursor} next={null} onCursor={setRepaymentCursor}/>}{repayments.copy?.data.items.map((row, i) => <div className="ledger-money-row" key={`${row.senderId}:${row.receiverId}:${i}`}>
        <span>{name(row.senderId)} to {name(row.receiverId)}</span>
        <output>{formatMoney(row.amountMinor, currency)}</output>{user.role !== "viewer" && <button className="button button--quiet" type="button" onClick={() => onPayment(row)}>Record this payment</button>}</div>)}{repayments.copy && <PageControls cursor={repaymentCursor} next={repayments.copy.data.nextCursor} onCursor={setRepaymentCursor}/>}</section>;
}
export function PageControls({ cursor, next, onCursor, failed = false }: {
    cursor?: string;
    next: string | null;
    failed?: boolean;
    onCursor: (value?: string) => void;
}) { return <div className="ledger-toolbar">{cursor && <button className="button button--quiet" type="button" onClick={() => onCursor(undefined)}>Restart from first page</button>}{next ? <button className="button button--quiet" type="button" onClick={() => onCursor(next)}>Next page</button> : !failed && <p>End of results</p>}</div>; }
