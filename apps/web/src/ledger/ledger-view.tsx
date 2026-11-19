"use client";
import { useMoneyLifetime } from "./money-lifetime";
import { object, integer, validPage, validDate } from "./validation";
import { memberLabel } from "./item-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@/lib/auth";
import type { ExpenseRule, Member } from "@/lib/expenses";
import type { HouseholdLocation, LedgerLocation } from "@/lib/navigation";
import { ResourceState, useHouseholdTask, useOnline, useResource } from "@/household/ui";
import { ExpensesView } from "@/components/expenses-view";
import { AmountField } from "./amount-field";
import { ledgerQuery, LedgerRequestError, previewPosting, validLedgerEntry } from "./api";
import { BalancesView, balanceWords, PageControls, useLedgerRead, validBalance } from "./balances-view";
import { EntryDetail, entryLabel } from "./entry-detail";
import { AttemptRecovery, EntryDialog, todayLedgerDate, useFinancialAttempt, type OnLedgerAccepted } from "./entry-dialog";
import { FinancialDialog, PaymentDialog } from "./payment-dialog";
import { StatementView } from "./statement-view";
import { MAX_PARTICIPANTS, decimalMoney, formatMoney, parseMoney } from "./allocation-preview";
import type { Currency, LedgerPage, LedgerEntry, RepaymentSuggestion, RecurringPostingSource, LedgerCommandDraft, SpendingTotal, SpendingGroup, AcceptedReference } from "./types";
import "./ledger.css";
const validMembers = (v: unknown): v is {
    members: Member[];
} => object(v) && Array.isArray(v.members) && v.members.every(m => object(m) && typeof m.id === "string" && typeof m.name === "string" && typeof m.active === "boolean");
const validSpending = (v: unknown): v is SpendingTotal => object(v) && ["INR", "USD", "EUR", "GBP", "JPY"].includes(String(v.currency)) && [v.expenseMinor, v.creditMinor, v.paymentMinor, v.netSpendingMinor, v.count].every(integer);
const entriesPage = (v: unknown): v is LedgerPage<LedgerEntry> & {
    totals: SpendingTotal[];
} => validPage(validLedgerEntry)(v) && object(v) && Array.isArray(v.totals) && v.totals.every(validSpending);
const personalPage = validPage(validBalance);
const validGroup = (v: unknown): v is SpendingGroup => validSpending(v) && object(v) && typeof v.group === "string";
const summariesPage = (v: unknown): v is LedgerPage<SpendingGroup> & {
    totals: SpendingTotal[];
    groupBy: "month" | "category";
} => validPage(validGroup)(v) && object(v) && Array.isArray(v.totals) && v.totals.every(validSpending) && ["month", "category"].includes(String(v.groupBy));
function validPostingSource(value:unknown):value is RecurringPostingSource {
 if(!object(value)||typeof value.ruleId!=="string"||!integer(value.ruleVersion)||!integer(value.period)||!validDate(String(value.periodStart))||!validDate(String(value.periodEnd))||!object(value.snapshot))return false;
 const snapshot=value.snapshot;
 if(typeof snapshot.name!=="string"||!["INR","USD","EUR","GBP","JPY"].includes(String(snapshot.currency))||!integer(snapshot.totalMinor)||snapshot.totalMinor<=0||!object(snapshot.cadence)||!Array.isArray(snapshot.shares)||snapshot.shares.length<1||snapshot.shares.length>12)return false;
 const shares=snapshot.shares;
 return shares.every(share=>object(share)&&typeof share.memberId==="string"&&integer(share.amountMinor)&&share.amountMinor>=0)&&shares.reduce((sum,share)=>sum+BigInt(Number(share.amountMinor)),BigInt(0))===BigInt(snapshot.totalMinor);
}
export function LedgerView({ user, location, onNavigate, onDirtyChange, acceptedReference, onRecorded }: {
    user: AuthUser;
    location: HouseholdLocation;
    onNavigate: (detail: LedgerLocation) => void;
    onDirtyChange?: (guarded: boolean) => void;
    acceptedReference?: AcceptedReference;
    onRecorded?: (reference: AcceptedReference) => void;
}) {
    const currency = location.currency ?? "INR";
    const tab = location.ledgerTab ?? "entries";
    const connected = useOnline();
    const membersResource = useResource(user, "ledger-members", "/api/v1/members", validMembers);
    const members = membersResource.copy?.data.members ?? [];
    const [editor, setEditor] = useState<"expense" | "payment">();
    const [suggestion, setSuggestion] = useState<RepaymentSuggestion>();
    const [rule, setRule] = useState<ExpenseRule>();
    const [notice, setNotice] = useState<string>();
    const [search, setSearch] = useState(location.search ?? "");
    const [category, setCategory] = useState(location.category ?? "");
    const personal = useLedgerRead(user, ledgerQuery("/balances", { currency, memberId: user.id, limit: 25 }), personalPage);
    const refreshPersonal = personal.refresh;
    const lifetime = useMoneyLifetime();
    const accepted: OnLedgerAccepted = useCallback(async (reference) => { setEditor(undefined); setRule(undefined); onDirtyChange?.(false); setNotice("Recorded. Accepted money is saved; refresh to inspect the latest balances."); onRecorded?.(reference); onNavigate({ ...location, entryId: reference.entryId }); if (!lifetime) void refreshPersonal(); }, [onNavigate, onDirtyChange, onRecorded, location, refreshPersonal, lifetime]);
    const save = useFinancialAttempt(user, accepted);
    const close = () => { setEditor(undefined); setRule(undefined); onDirtyChange?.(false); void save.refresh(); };
    const navigate = (patch: LedgerLocation) => onNavigate({ ...location, ...patch });
    const selectedPersonal = personal.copy?.data.items.find(row => row.memberId === user.id && row.currency === currency);
    return <section className="ledger-panel" aria-labelledby="ledger-title">
    <header className="ledger-toolbar">
    <div>
    <h2 id="ledger-title">Expenses</h2>
    <p>Your balance · {currency}</p>{selectedPersonal ? <strong className="ledger-total">{balanceWords(selectedPersonal.netMinor, currency, true)}</strong> : personal.loading ? <p role="status">Loading your balance…</p> : personal.copy ? <strong className="ledger-total">Settled</strong> : <p>Balance unavailable</p>}<p>Complete current balance, independent of record filters.</p>
    </div>
    <div className="ledger-tools">
    <label className="field">
    <span>Ledger currency</span>
    <select value={currency} onChange={e => navigate({ currency: e.target.value as Currency, ledgerCursor: undefined })}>{["INR", "USD", "EUR", "GBP", "JPY"].map(c => <option key={c}>{c}</option>)}</select>
    </label>{user.role !== "viewer" && <button className="button button--primary" type="button" disabled={!membersResource.copy} onClick={() => setEditor("expense")}>Add expense</button>}</div>
    </header>
    <ResourceState {...personal} retry={() => void personal.refresh()}/>{user.role === "viewer" && <p>Viewers can inspect shared finances but cannot record changes.</p>}{!connected && <p className="ledger-notice">Offline · saved financial copies are read-only. Connect to record changes.</p>}{(notice || acceptedReference) && <p role="status">Recorded. This accepted save is complete.{acceptedReference && location.entryId !== acceptedReference.entryId && <button className="button button--quiet" type="button" onClick={() => navigate({ entryId: acceptedReference.entryId })}>Open recorded entry</button>}</p>}
 <nav className="ledger-tabs" aria-label="Money sections">{([['entries', 'Expenses'], ['balances', 'Balances'], ['rules', 'Recurring rules']] as const).map(([value, label]) => <button className={tab === value ? "is-active" : ""} aria-current={tab === value ? "page" : undefined} type="button" key={value} onClick={() => navigate({ ledgerTab: value, entryId: undefined, statementMemberId: undefined, ledgerCursor: undefined })}>{label}</button>)}</nav>
 {save.error && <p role="alert">{save.error}</p>}{save.attempt && !editor && !rule && <AttemptRecovery attempt={save.attempt} pending={save.pending} connected={connected} onCheck={() => void save.check()} onReplay={() => void save.replay()} members={members} canReplay={user.role !== "viewer"}/>}
 <ResourceState {...membersResource} retry={() => void membersResource.refresh()}/>
 {location.entryId ? <EntryDetail key={location.entryId} user={user} members={members} entryId={location.entryId} onEditorClose={() => void save.refresh()} onBack={() => navigate({ entryId: undefined })} onAccepted={async (ref, result) => { void save.refresh(); await accepted(ref, result); }} onDirtyChange={onDirtyChange}/> : location.statementMemberId ? <StatementView key={`${location.statementMemberId}:${currency}`} user={user} memberId={location.statementMemberId} name={memberLabel(members, location.statementMemberId)} currency={currency} from={location.from} to={location.to} cursor={location.ledgerCursor} onScope={scope => navigate({ ...scope, ledgerCursor: undefined })} onCursor={ledgerCursor => navigate({ ledgerCursor })} onEntry={entryId => navigate({ entryId })} onBack={() => navigate({ statementMemberId: undefined, ledgerCursor: undefined, ledgerTab: "balances" })}/> : tab === "balances" ? <BalancesView key={currency} user={user} members={members} currency={currency} cursor={location.ledgerCursor} onCursor={ledgerCursor => navigate({ ledgerCursor })} onStatement={statementMemberId => navigate({ statementMemberId, ledgerCursor: undefined })} onPayment={value => { setSuggestion(value); setEditor("payment"); }}/> : tab === "rules" ? <ExpensesView user={user} readOnly={user.role === "viewer"} onPost={setRule} onDirtyChange={onDirtyChange}/> : <>
        <form className="ledger-filters" onSubmit={e => { e.preventDefault(); navigate({ search: search.trim() || undefined, category: category.trim() || undefined, ledgerCursor: undefined }); }}>
        <label className="field">
        <span>Search financial records</span>
        <input type="search" maxLength={160} value={search} onChange={e => setSearch(e.target.value)}/>
        </label>
        <label className="field">
        <span>Category</span>
        <input maxLength={200} value={category} onChange={e => setCategory(e.target.value)}/>
        </label>
        <button className="button button--quiet" type="submit">Apply filters</button>
        <label className="field">
        <span>Record type</span>
        <select value={location.kind ?? ""} onChange={e => navigate({ kind: e.target.value as LedgerLocation["kind"] || undefined, ledgerCursor: undefined })}>
        <option value="">All types</option>
        <option value="expense">Expenses</option>
        <option value="refund">Refunds</option>
        <option value="payment">Recorded payments</option>
        </select>
        </label>
        <label className="field">
        <span>Record status</span>
        <select value={location.lifecycle ?? "effective"} onChange={e => navigate({ lifecycle: e.target.value as LedgerLocation["lifecycle"], ledgerCursor: undefined })}>
        <option value="effective">Effective</option>
        <option value="void">Voided</option>
        <option value="all">All statuses</option>
        </select>
        </label>
        <label className="field">
        <span>Person</span>
        <select value={location.ledgerMemberId ?? ""} onChange={e => navigate({ ledgerMemberId: e.target.value || undefined, ledgerCursor: undefined })}>
        <option value="">All people</option>{members.map(m => <option value={m.id} key={m.id}>{m.name}{!m.active ? " · departed" : ""}</option>)}</select>
        </label>
        <label className="field">
        <span>From date</span>
        <input type="date" value={location.from ?? ""} onChange={e => navigate({ from: e.target.value || undefined, ledgerCursor: undefined })}/>
        </label>
        <label className="field">
        <span>To date</span>
        <input type="date" value={location.to ?? ""} onChange={e => navigate({ to: e.target.value || undefined, ledgerCursor: undefined })}/>
        </label>
        </form>
        <Records user={user} members={members} location={location} currency={currency} onNavigate={navigate}/>
        </>}
 {editor === "expense" && <EntryDialog user={user} members={members} initialCurrency={currency} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}{editor === "payment" && <PaymentDialog user={user} members={members} defaultCurrency={currency} suggestion={suggestion} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange}/>}{rule && <PostingDialog key={rule.id} user={user} members={members} rule={rule} onClose={close} onAccepted={accepted} onDirtyChange={onDirtyChange} onExisting={entryId => { close(); navigate({ entryId }); }}/>}</section>;
}
function Records({ user, members, location, currency, onNavigate }: {
    user: AuthUser;
    members: Member[];
    location: HouseholdLocation;
    currency: Currency;
    onNavigate: (patch: LedgerLocation) => void;
}) {
    const filter = { currency, from: location.from, to: location.to, search: location.search, memberId: location.ledgerMemberId, category: location.category };
    const records = useLedgerRead(user, ledgerQuery("/entries", { ...filter, kind: location.kind, lifecycle: location.lifecycle ?? "effective", cursor: location.ledgerCursor, limit: 25 }), entriesPage);
    const [groupBy, setGroup] = useState<"month" | "category">("month");
    const [summaryCursor, setSummaryCursor] = useState<string>();
    const summary = useLedgerRead(user, ledgerQuery("/summaries", { ...filter, groupBy, cursor: summaryCursor, limit: 25 }), summariesPage);
    return <>
    <ResourceState {...records} retry={() => void records.refresh()}/>{records.error&&!records.copy&&location.ledgerCursor&&<PageControls failed cursor={location.ledgerCursor} next={null} onCursor={ledgerCursor=>onNavigate({ledgerCursor})}/>}{records.copy && <>
        <p>Accepted financial revision {records.copy.data.revision}</p>{records.copy.data.items.length === 0 && <p>{location.search || location.kind || location.from || location.to || location.ledgerMemberId || location.category || location.lifecycle === "void" ? "No records match these filters." : "No expenses recorded yet"}</p>}{records.copy.data.items.map(entry => <article className="ledger-record" key={entry.id}>
            <button type="button" onClick={() => onNavigate({ entryId: entry.id })}>
            <strong>{entry.intent.kind === "payment" ? "Recorded payment" : entry.intent.description}</strong>
            <small>{entryLabel(entry)} · {entry.intent.date} · {entry.lifecycle === "void" ? "Voided" : "Accepted"}</small>
            </button>
            <output>{formatMoney(entry.intent.totalMinor, entry.intent.currency)}</output>
            </article>)}<PageControls cursor={location.ledgerCursor} next={records.copy.data.nextCursor} onCursor={ledgerCursor => onNavigate({ ledgerCursor })}/>
        <h3>Spending summary · {currency}</h3>
        <p>Spending scope · {location.from ?? "all history"} through {location.to ?? "all dates"}{location.search ? ` · search “${location.search}”` : ""}{location.ledgerMemberId ? ` · ${members.find(member => member.id === location.ledgerMemberId)?.name ?? "selected person"}` : ""}{location.category ? ` · category “${location.category}”` : ""}. Repayments are excluded; record type/status filters do not alter this spending scope.</p>
        <label className="field">
        <span>Group spending</span>
        <select value={groupBy} onChange={e => { setGroup(e.target.value as typeof groupBy); setSummaryCursor(undefined); }}>
        <option value="month">Month</option>
        <option value="category">Category</option>
        </select>
        </label>
        <ResourceState {...summary} retry={() => void summary.refresh()}/>{summary.error&&!summary.copy&&summaryCursor&&<PageControls failed cursor={summaryCursor} next={null} onCursor={setSummaryCursor}/>}{summary.copy && <section aria-label="Complete spending totals">
            <h4>Complete spending totals · revision {summary.copy.data.revision}</h4>{summary.copy.data.totals.map(total => <dl className="ledger-breakdown" key={total.currency}>
                <div>
                <dt>Expenses · {total.currency}</dt>
                <dd>{formatMoney(total.expenseMinor, total.currency)}</dd>
                </div>
                <div>
                <dt>Refunds</dt>
                <dd>{formatMoney(total.creditMinor, total.currency)}</dd>
                </div>
                <div>
                <dt>Net spending</dt>
                <dd>{formatMoney(total.netSpendingMinor, total.currency)}</dd>
                </div>
                </dl>)}<p>Groups below show one page of this complete scope.</p>
            </section>}{summary.copy?.data.items.map(row => <div className="ledger-money-row" key={row.group}>
            <span>{row.group || "Uncategorized"}</span>
            <output>Expenses {formatMoney(row.expenseMinor, currency)} · refunds {formatMoney(row.creditMinor, currency)} · net {formatMoney(row.netSpendingMinor, currency)}</output>
            </div>)}{summary.copy && <PageControls cursor={summaryCursor} next={summary.copy.data.nextCursor} onCursor={setSummaryCursor}/>}</>}</>;
}
function PostingDialog({ rule, onExisting, ...props }: Parameters<typeof PaymentDialog>[0] & {
    rule: ExpenseRule;
    onExisting: (id: string) => void;
}) {
    const [observed] = useState(rule);
    const [period, setPeriod] = useState("0");
    const [date, setDate] = useState(todayLedgerDate);
    const [payers, setPayers] = useState(() => [{ memberId: props.user.id, value: decimalMoney(observed.amountMinor, observed.currency as Currency) }]);
    const [source, setSource] = useState<RecurringPostingSource>();
    const [error, setError] = useState<string>();
    const [previewing, setPreviewing] = useState(false);
    const task = useHouseholdTask(props.user);
    const sequence = useRef(0);
    useEffect(() => { let active = true; const request = ++sequence.current; queueMicrotask(() => { if (!active)
        return; setSource(undefined); setError(undefined); if (!/^\d+$/.test(period) || !Number.isSafeInteger(Number(period))) {
        setError("Choose a nonnegative cadence period.");
        return;
    } setPreviewing(true); void task(() => previewPosting(props.user, { ruleId: observed.id, expectedRuleVersion: observed.version, period: Number(period) }), result => { if (active && request === sequence.current) {
        const s = result.source;
        if (validPostingSource(s) && s.ruleId === observed.id && s.ruleVersion === observed.version && s.period === Number(period) && validDate(s.periodStart) && validDate(s.periodEnd) && s.snapshot.currency === observed.currency) {
            setSource(s);
        }
        else
            setError("The period preview could not be verified.");
        setPreviewing(false);
    } }, failure => { if (active && request === sequence.current) {
        setError(failure instanceof Error ? failure.message : "Period preview unavailable.");
        setPreviewing(false);
    } }); }); return () => { active = false; }; }, [task, observed, props.user, period]);
    const contributions = payers.map(p => ({ memberId: p.memberId, amountMinor: parseMoney(p.value, observed.currency as Currency) }));
    const total = contributions.reduce((sum, p) => sum + (p.amountMinor ?? 0), 0);
    const problem = previewing ? "Loading normalized server period…" : error ?? (!source ? "Inspect a current period preview first." : !validDate(date) ? "Enter a real date." : contributions.some(p => p.amountMinor === null) || total !== observed.amountMinor ? "Payer contributions must equal this observed rule total." : !payers.length || new Set([...(source?.snapshot.shares.map(p=>p.memberId)??[]),...payers.map(p=>p.memberId)]).size > MAX_PARTICIPANTS || payers.some(p => !props.members.some(m => m.id === p.memberId && m.active)) ? "Choose at most 12 active payers." : undefined);
    const draftSnapshot = JSON.stringify({ period, date, payers });
    const [initialDraft] = useState(draftSnapshot);
    const command: LedgerCommandDraft = { action: "post", ruleId: observed.id, expectedRuleVersion: observed.version, period: Number(period), date, payers: contributions.map(p => ({ memberId: p.memberId, amountMinor: p.amountMinor ?? 0 })) };
    return <FinancialDialog {...props} title="Post recurring period" dirty={draftSnapshot !== initialDraft} command={command} problem={problem} saveLabel="Record period expense" refusalContent={(failure, releaseOwnGuard) => {
            const existing = failure instanceof LedgerRequestError ? failure.details : undefined;
            return validLedgerEntry(existing) && existing.householdId === props.user.householdId && existing.intent.kind === "expense" && existing.source?.ruleId === observed.id && source && existing.source.periodStart === source.periodStart ? <p>This period already has an original{existing.lifecycle === "void" ? " (voided)" : ""}.<button type="button" className="button button--quiet" onClick={() => { releaseOwnGuard(); onExisting(existing.id); }}>Open existing original</button>
            </p> : null;
        }}>
    <p>{observed.name} · observed rule version {observed.version}. A recurring rule is a template until you record its period.</p>
    <label className="field">
    <span>Billing period number</span>
    <input type="number" min={0} step={1} value={period} onChange={e => setPeriod(e.target.value)}/>
    </label>
    <p>Period 0 starts at the rule’s original anchor, {observed.cadence.anchorDate}. Choose the next period number for the next cadence interval.</p>{source && <section><p>Normalized period · {source.periodStart} to {source.periodEnd} (exclusive) · {formatMoney(source.snapshot.totalMinor, source.snapshot.currency)}</p><h3>Observed rule shares</h3>{source.snapshot.shares.map(share=><p key={share.memberId}>{memberLabel(props.members,share.memberId)} · {formatMoney(share.amountMinor,source.snapshot.currency)}</p>)}</section>}<label className="field">
    <span>Actual expense date</span>
    <input type="date" value={date} onChange={e => setDate(e.target.value)}/>
    </label>
    <fieldset className="ledger-group">
    <legend>Actual payers</legend>{props.members.filter(m => m.active).map(member => {
            const row = payers.find(p => p.memberId === member.id);
            return <div className="ledger-person" key={member.id}>
            <label>
            <input type="checkbox" checked={!!row} onChange={e => setPayers(old => e.target.checked ? [...old, { memberId: member.id, value: "" }] : old.filter(p => p.memberId !== member.id))}/> {member.name}</label>{row && <AmountField label={`Actual contribution by ${member.name}`} value={row.value} currency={observed.currency as Currency} onChange={value => setPayers(old => old.map(p => p.memberId === member.id ? { ...p, value } : p))} allowZero/>}</div>;
        })}<p>Payer total · {formatMoney(total, observed.currency as Currency)}</p>
    </fieldset>
    <p>The recorded source keeps this normalized period and observed share snapshot. Voiding its original never frees this period for another original.</p>
    </FinancialDialog>;
}
