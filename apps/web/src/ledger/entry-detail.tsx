"use client";
import { object, integer, validPage } from "./validation";
import { memberLabel } from "./item-editor";
import { useMoneyLifetime } from "./money-lifetime";
import { useState } from "react";
import type { AuthUser } from "@/lib/auth";
import type { Member } from "@/lib/expenses";
import { ResourceState } from "@/household/ui";
import { ledgerQuery, validLedgerEntry } from "./api";
import { useLedgerRead, PageControls } from "./balances-view";
import { EntryDialog, type OnLedgerAccepted } from "./entry-dialog";
import { FinancialDialog, PaymentDialog } from "./payment-dialog";
import { RefundDialog } from "./refund-dialog";
import { formatMoney } from "./allocation-preview";
import type { LedgerEntry, LedgerComment, StoredLedgerRevision, RefundCapacity, LedgerCommandDraft } from "./types";
export interface EntryDetailData {
    entry: LedgerEntry;
    revision: number;
    refundCapacity?: RefundCapacity;
}
export const validDetail = (v: unknown): v is EntryDetailData => object(v) && validLedgerEntry(v.entry) && integer(v.revision) && (v.refundCapacity === undefined || validCapacity(v.refundCapacity));
function validCapacity(v: unknown): v is RefundCapacity { return object(v) && typeof v.expenseId === "string" && typeof v.available === "boolean" && [v.totalMinor, v.creditedMinor, v.remainingMinor].every(integer) && [v.payers, v.shares].every(rows => Array.isArray(rows) && rows.every(p => object(p) && typeof p.memberId === "string" && [p.originalMinor, p.creditedMinor, p.remainingMinor].every(integer))); }
const commentsPage = validPage((v): v is LedgerComment => object(v) && typeof v.id === "string" && typeof v.entryId === "string" && typeof v.authorId === "string" && typeof v.text === "string" && typeof v.acceptedAt === "string" && integer(v.observedVersion));
const historyPage = validPage((v): v is StoredLedgerRevision => object(v) && validLedgerEntry(v.snapshot) && typeof v.actorId === "string" && typeof v.acceptedAt === "string" && typeof v.action === "string" && integer(v.version) && Array.isArray(v.transitions) && v.transitions.every(t => object(t) && typeof t.memberId === "string" && integer(t.amountMinor) && ["INR","USD","EUR","GBP","JPY"].includes(String(t.currency)) && ["reversal", "replacement"].includes(String(t.effectKind))));
export function EntryDetail({ user, members, entryId, onBack, onAccepted, onDirtyChange, onEditorClose }: {
    user: AuthUser;
    members: Member[];
    entryId: string;
    onBack: () => void;
    onAccepted: OnLedgerAccepted;
    onDirtyChange?: (dirty: boolean) => void;
    onEditorClose?: () => void;
}) {
    const lifetime = useMoneyLifetime();
    const detail = useLedgerRead(user, ledgerQuery(`/entries/${encodeURIComponent(entryId)}`), validDetail, "detail");
    const [commentCursor, setCommentCursor] = useState<string>();
    const [historyCursor, setHistoryCursor] = useState<string>();
    const comments = useLedgerRead(user, ledgerQuery(`/entries/${encodeURIComponent(entryId)}/comments`, { cursor: commentCursor, limit: 25 }), commentsPage);
    const history = useLedgerRead(user, ledgerQuery(`/entries/${encodeURIComponent(entryId)}/history`, { cursor: historyCursor, limit: 25 }), historyPage);
    const entry = detail.copy?.data.entry;
    const [editor, setEditor] = useState<"correct" | "duplicate" | "refund" | "comment" | "void" | "restore">();
    const [observed, setObserved] = useState<LedgerEntry>();
    const openEditor = (next: NonNullable<typeof editor>) => { setObserved(entry); setEditor(next); };
    const [comment, setComment] = useState("");
    const name = (id: string) => memberLabel(members, id);
    const close = () => { setEditor(undefined); setObserved(undefined); setComment(""); onDirtyChange?.(false); onEditorClose?.(); };
    const accepted: OnLedgerAccepted = async (reference, result) => { close(); await onAccepted(reference, result); if (!lifetime) await Promise.all([detail.refresh(), comments.refresh(), history.refresh()]); };
    const input = entry?.intent;
    const target = observed ?? entry;
    const command: LedgerCommandDraft | undefined = target && editor === "comment" ? { action: "comment", entryId: target.id, expectedVersion: target.version, text: comment.trim() } : target && (editor === "void" || editor === "restore") ? { action: editor, entryId: target.id, expectedVersion: target.version } : undefined;
    return <section className="ledger-detail" aria-label="Financial entry">
    <button type="button" className="button button--quiet" onClick={onBack}>Back to previous money view</button>
    <ResourceState {...detail} retry={() => void detail.refresh()}/>{entry && input && <>
        <header>
        <p>{entryLabel(entry)} · {entry.lifecycle === "void" ? "Voided · no current balance effect" : "Accepted"} · Version {entry.version}</p>
        <h2>{input.kind === "payment" ? `Recorded payment · ${name(input.senderId)} to ${name(input.receiverId)}` : input.description}</h2>
        <p className="ledger-total">{formatMoney(input.totalMinor, input.currency)}</p>
        <p>{input.date} · {input.currency}</p>
        </header>{input.notes && <section>
            <h3>Notes</h3>
            <p className="ledger-prose">{input.notes}</p>
            </section>}{input.kind === "payment" ? <p>Reported method · {input.method}{input.reference ? ` · ${input.reference}` : ""}. This records a reported payment; Home OS did not execute a transfer.</p> : <>
            <h3>Contributions</h3>{entry.payers.map(p => <div className="ledger-money-row" key={p.memberId}>
                <span>{name(p.memberId)}</span>
                <output>{formatMoney(p.amountMinor, input.currency)}</output>
                </div>)}<h3>Allocated consumption{input.kind === "refund" ? " reversed" : ""}</h3>{entry.shares.map(p => <div className="ledger-money-row" key={p.memberId}>
                <span>{name(p.memberId)}</span>
                <output>{formatMoney(p.amountMinor, input.currency)}</output>
                </div>)}</>}{entry.itemized && <section>
            <h3>Itemized explanation</h3>{entry.itemized.items.map((item, i) => <article key={i}>
                <h4>{item.label}</h4>
                <p>{item.quantity} × {formatMoney(item.unitPriceMinor, input.currency)} = {formatMoney(item.totalMinor, input.currency)}</p>{item.shares.map(p => <p key={p.memberId}>{name(p.memberId)} · {formatMoney(p.amountMinor, input.currency)}</p>)}</article>)}<p>Subtotal {formatMoney(entry.itemized.subtotalMinor, input.currency)} − discount {formatMoney(entry.itemized.discountMinor, input.currency)} + tax {formatMoney(entry.itemized.taxMinor, input.currency)} + tip {formatMoney(entry.itemized.tipMinor, input.currency)} = {formatMoney(entry.itemized.totalMinor, input.currency)}. Discount is applied before tax and tip.</p>{entry.itemized.breakdown.map(p => <p key={p.memberId}>{name(p.memberId)} · base {formatMoney(p.baseMinor, input.currency)}, discount {formatMoney(p.discountMinor, input.currency)}, tax {formatMoney(p.taxMinor, input.currency)}, tip {formatMoney(p.tipMinor, input.currency)} · final {formatMoney(p.amountMinor, input.currency)}</p>)}</section>}{entry.source && <p>Recurring source · {entry.source.snapshot.name} · {entry.source.periodStart} to {entry.source.periodEnd} (exclusive). Rule version {entry.source.ruleVersion}.</p>}{user.role !== "viewer" && <div className="ledger-toolbar">{entry.lifecycle === "effective" && <>
                <button className="button button--quiet" type="button" onClick={() => openEditor("correct")}>Correct entry</button>{input.kind === "expense" && <button className="button button--quiet" type="button" onClick={() => openEditor("refund")}>Record refund</button>}<button className="button button--quiet" type="button" onClick={() => openEditor("void")}>Void entry</button>
                </>}{input.kind === "expense" && <button className="button button--quiet" type="button" onClick={() => openEditor("duplicate")}>Duplicate expense</button>}{entry.lifecycle === "void" && <button className="button button--quiet" type="button" onClick={() => openEditor("restore")}>Restore entry</button>}<button className="button button--quiet" type="button" onClick={() => openEditor("comment")}>Add comment</button>
            </div>}<h3>Comments</h3>
        <p>Immutable explanations; comments never change balances.</p>
        <ResourceState {...comments} retry={() => void comments.refresh()}/>{comments.error&&!comments.copy&&commentCursor&&<PageControls failed cursor={commentCursor} next={null} onCursor={setCommentCursor}/>}{comments.copy?.data.items.map(row => <article className="ledger-comment" key={row.id}>
            <p className="ledger-prose">{row.text}</p>
            <small>{name(row.authorId)} · {row.acceptedAt} · observed version {row.observedVersion}</small>
            </article>)}{comments.copy && <PageControls cursor={commentCursor} next={comments.copy.data.nextCursor} onCursor={setCommentCursor}/>}<h3>Financial revision history</h3>
        <ResourceState {...history} retry={() => void history.refresh()}/>{history.error&&!history.copy&&historyCursor&&<PageControls failed cursor={historyCursor} next={null} onCursor={setHistoryCursor}/>}{history.copy?.data.items.map(row => <article className="ledger-history" key={row.version}>
            <h4>Version {row.version} · {row.action}</h4>
            <p>{name(row.actorId)} · {row.acceptedAt}</p>
            <p>{formatMoney(row.snapshot.intent.totalMinor, row.snapshot.intent.currency)} · {row.snapshot.lifecycle}</p>{row.transitions.map((t, i) => <p key={i}>{t.effectKind === "reversal" ? "Reversal" : "Replacement"} · {name(t.memberId)} · {formatMoney(t.amountMinor, t.currency)}</p>)}</article>)}{history.copy && <PageControls cursor={historyCursor} next={history.copy.data.nextCursor} onCursor={setHistoryCursor}/>}</>}
 {entry && editor && (editor === "correct" || editor === "duplicate") && input?.kind === "expense" && <EntryDialog user={user} members={members} entry={observed ?? entry} duplicate={editor === "duplicate"} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}
 {entry && editor === "correct" && input?.kind === "payment" && <PaymentDialog user={user} members={members} entry={observed ?? entry} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}
 {entry && editor === "refund" && detail.copy?.data.refundCapacity && <RefundDialog user={user} members={members} original={entry} capacity={detail.copy.data.refundCapacity} capacityState={<RefundCapacityState {...detail}/>} onRefreshCapacity={() => void detail.refresh()} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}
 {entry && editor === "correct" && target?.intent.kind === "refund" && <LinkedRefundEditor key={target.intent.expenseId} user={user} members={members} entry={target} originalId={target.intent.expenseId} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}
 {target && command && <FinancialDialog title={editor === "comment" ? "Add immutable comment" : editor === "void" ? "Void financial entry" : "Restore financial entry"} user={user} members={members} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange} dirty={editor === "comment" ? !!comment : false} command={command} problem={editor === "comment" && !comment.trim() ? "Enter a comment." : undefined} saveLabel={editor === "comment" ? "Append comment" : editor === "void" ? "Confirm void" : "Confirm restore"}>{editor === "comment" ? <label className="field">
            <span>Comment</span>
            <textarea maxLength={2000} value={comment} onChange={e => setComment(e.target.value)}/>
            </label> : <p>{editor === "void" ? "Void retains accepted history and reverses this entry's current financial effect. Active linked refunds must be resolved first." : "Restore reinstates the historical snapshot only if current capacity and linked original limits permit it. It does not create a new expense."} {formatMoney(target.intent.totalMinor, target.intent.currency)} · observed version {target.version}.</p>}<p>On a stale version refusal, close this draft and use Try again above to deliberately review the latest entry before starting another change.</p>
        </FinancialDialog>}
 </section>;
}
export function entryLabel(entry: LedgerEntry) { return entry.intent.kind === "expense" ? "Expense" : entry.intent.kind === "refund" ? "Refund" : "Recorded payment"; }

function LinkedRefundEditor({ originalId, ...props }: {
    originalId: string;
    user: AuthUser;
    members: Member[];
    entry: LedgerEntry;
    onClose: () => void;
    onAccepted: OnLedgerAccepted;
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const original = useLedgerRead(props.user, ledgerQuery(`/entries/${encodeURIComponent(originalId)}`), validDetail, "detail");
    const data = original.copy?.data;
    return <section aria-label="Original expense for refund">
        {data?.refundCapacity ? <RefundDialog {...props} original={data.entry} capacity={data.refundCapacity} capacityState={<RefundCapacityState {...original}/>} onRefreshCapacity={() => void original.refresh()}/> : <>
            <ResourceState {...original} retry={() => void original.refresh()}/>
            {!original.loading && !original.error && <p role="alert">The original expense has no refundable capacity. Refresh the original before continuing.<button type="button" onClick={() => void original.refresh()}>Refresh original expense</button></p>}
            <button type="button" onClick={props.onClose}>Cancel refund correction</button>
        </>}
    </section>;
}

function RefundCapacityState({ loading, error, copy, refresh }: ReturnType<typeof useLedgerRead<EntryDetailData>>) {
    return <>
        {loading && <p role="status">Loading original expense…</p>}
        {error && <p role="alert">{error} <button type="button" onClick={() => void refresh()}>Try again</button></p>}
        {copy?.cached && <p role="status">Saved original expense copy · {new Date(copy.savedAt).toLocaleString()}. Connect to check for changes.</p>}
    </>;
}
