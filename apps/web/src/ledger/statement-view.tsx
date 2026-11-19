"use client";
import { object, integer, validPage } from "./validation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "@/lib/auth";
import { ResourceState, useHouseholdTask, useOnline } from "@/household/ui";
import { ledgerQuery } from "./api";
import { useLedgerRead, PageControls } from "./balances-view";
import { formatMoney } from "./allocation-preview";
import { downloadStatement } from "./export";
import type { Currency, StatementPage, StatementMovement } from "./types";
const movementPage = validPage((v): v is StatementMovement => object(v) && typeof v.entryId === "string" && integer(v.version) && typeof v.date === "string" && typeof v.description === "string" && typeof v.currency === "string" && integer(v.amountMinor) && integer(v.runningMinor));
const validStatement = (v: unknown): v is StatementPage => movementPage(v) && object(v) && object(v.scope) && typeof v.scope.memberId === "string" && v.scope.basis === "current-effective" && [v.openingMinor, v.movementMinor, v.closingMinor, v.movementCount].every(integer);
export function StatementView({ user, memberId, name, currency, from, to, cursor, onScope, onCursor, onEntry, onBack }: {
    user: AuthUser;
    memberId: string;
    name: string;
    currency: Currency;
    from?: string;
    to?: string;
    cursor?: string;
    onScope: (scope: {
        from?: string;
        to?: string;
    }) => void;
    onCursor: (cursor?: string) => void;
    onEntry: (id: string) => void;
    onBack: () => void;
}) {
    const scopedStatement = useCallback((value:unknown):value is StatementPage => validStatement(value) && value.scope.memberId===memberId && value.scope.currency===currency && value.scope.from===(from??null) && value.scope.to===(to??null) && value.items.every(row=>row.currency===currency) && BigInt(value.openingMinor)+BigInt(value.movementMinor)===BigInt(value.closingMinor),[memberId,currency,from,to]);
    const resource = useLedgerRead(user, ledgerQuery("/statements", { memberId, currency, from, to, cursor, limit: 25 }), scopedStatement);
    const connected = useOnline();
    const task = useHouseholdTask(user);
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState("");
    const [error, setError] = useState<string>();
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), [memberId, currency, from, to, user.id, user.householdId, user.role]);
    async function start(format: "csv" | "json") { if (exporting)
        return; const active = new AbortController(); controller.current = active; setExporting(true); setError(undefined); await task(() => downloadStatement(user, { memberId, currency, from, to, format }, { signal: active.signal, onProgress: (count, total) => setProgress(`${count} / ${total} movements`) }), () => { setExporting(false); setProgress("Complete statement downloaded."); }, failure => { setExporting(false); setError(failure instanceof Error ? failure.message : "Export could not be prepared."); }); }
    const page = resource.copy?.data;
    return <section aria-label="Member statement">
    <button className="button button--quiet" type="button" onClick={onBack}>Back to balances</button>
    <h2>Statement · {name} · {currency}</h2>
    <div className="ledger-columns">
    <label className="field">
    <span>From date</span>
    <input type="date" value={from ?? ""} onChange={e => onScope({ from: e.target.value || undefined, to })}/>
    </label>
    <label className="field">
    <span>To date</span>
    <input type="date" value={to ?? ""} onChange={e => onScope({ from, to: e.target.value || undefined })}/>
    </label>
    </div>
    <p>{from ?? "All history"} through {to ?? "all entered dates"} (inclusive). Current effective accepted facts; corrections may change a statement generated later.</p>
    <ResourceState {...resource} retry={() => void resource.refresh()}/>{resource.error&&!resource.copy&&cursor&&<PageControls failed cursor={cursor} next={null} onCursor={onCursor}/>}{page && <>
        <p>Accepted financial revision {page.revision}</p>
        <dl className="ledger-breakdown">{[["Opening balance", page.openingMinor], ["Movements", page.movementMinor], ["Closing balance", page.closingMinor]].map(([label, value]) => <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{formatMoney(Number(value), currency)}</dd>
            </div>)}</dl>
        <p>Opening + movements = closing · {page.movementCount} complete-scope movements</p>{page.items.length === 0 && <p>No movements in this statement scope.</p>}{page.items.map(row => <article className="ledger-record" key={`${row.entryId}:${row.version}`}>
            <button type="button" onClick={() => onEntry(row.entryId)}>
            <strong>{row.description}</strong>
            <small>{row.date} · {row.kind} · version {row.version}</small>
            </button>
            <output>{formatMoney(row.amountMinor, currency)}</output>
            <small>Running balance · {formatMoney(row.runningMinor, currency)}</small>
            </article>)}<PageControls cursor={cursor} next={page.nextCursor} onCursor={onCursor}/>
        </>}<div className="ledger-toolbar">
    <button className="button button--quiet" type="button" disabled={!connected || exporting} onClick={() => void start("csv")}>Export complete CSV</button>
    <button className="button button--quiet" type="button" disabled={!connected || exporting} onClick={() => void start("json")}>Export complete JSON</button>{exporting && <button className="button button--quiet" type="button" onClick={() => controller.current?.abort()}>Cancel export</button>}</div>{progress && <p role="status">{progress}</p>}{error && <p role="alert">{error} Choose Export again to restart at one current revision, or narrow the date range.</p>}</section>;
}
