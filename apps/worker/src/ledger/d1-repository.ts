import { D1ExpenseRepository } from "../expenses/catalog/d1-repository";
import { ExpenseService } from "../expenses/catalog/service";
import { assertAuthority } from '../auth/authority';
import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import { ConflictError, NotFoundError, ValidationError } from '../platform/errors';
import { beginCommand, commandGuard, commitCommand, replayCommand } from '../platform/household-command';
import type { LedgerComment, LedgerEffect, LedgerEntry, StoredLedgerRevision } from './model';
import type { LedgerAcceptance, LedgerRepository } from './repository';
import { effects } from './allocation';
/** All write guards and retained money are submitted in one D1 transactional batch. */
export class D1LedgerRepository implements LedgerRepository {
    constructor(private readonly database: D1Database) { }
    async begin(context: CommandContext, action: string, entryId: string | undefined, input: unknown) {
        const command = await beginCommand(this.database, context, 'ledger_entry', action, entryId, input);
        return { command, replay: await replayCommand<LedgerEntry>(this.database, command) };
    }
    async beginComment(context: CommandContext, entryId: string, text: string) {
        const command = await beginCommand(this.database, context, 'ledger_comment', 'ledger.comment.added', undefined, { entryId, text });
        return { command, replay: await replayCommand<LedgerComment>(this.database, command) };
    }
    postingBasis(householdId: string, ruleId: string, expectedVersion: number, period: number) {
        return new ExpenseService(new D1ExpenseRepository(this.database)).postingBasis(householdId, ruleId, expectedVersion, period);
    }
    async acceptComment(command: import('../platform/household-command').HouseholdCommand, comment: LedgerComment, expectedVersion: number): Promise<LedgerComment> {
        const h = command.context.householdId;
        command.changes = [{ field: 'ledger_comment', before: null, after: comment }];
        return commitCommand(this.database, command, comment, comment.id, comment.acceptedAt, [
            commandGuard(this.database, command, expectedVersion, 'SELECT version FROM ledger_entries WHERE household_id=? AND id=?', [h, comment.entryId]),
            this.database.prepare(`INSERT INTO ledger_comments(household_id,id,entry_id,observed_version,author_id,operation_id,text,accepted_at) VALUES(?,?,?,?,?,?,?,?)`)
                .bind(h, comment.id, comment.entryId, expectedVersion, command.context.actorId, command.context.operationId, comment.text, comment.acceptedAt),
        ], async () => {
            const current = await this.getEntry(h, comment.entryId);
            await this.authorize(command.context, command.policyAction);
            if (current.version !== expectedVersion) throw new ConflictError('ledger_entry', comment.entryId, expectedVersion, current.version, current);
        });
    }
    authorize(context: CommandContext, action: Action) { return assertAuthority(this.database, context, action); }
    async getEntry(householdId: string, entryId: string): Promise<LedgerEntry> {
        const row = await this.database.prepare(`SELECT r.snapshot_json FROM ledger_entries h JOIN ledger_revisions r ON r.household_id=h.household_id AND r.entry_id=h.id AND r.version=h.version WHERE h.household_id=? AND h.id=?`).bind(householdId, entryId).first<{
            snapshot_json: string;
        }>();
        if (!row)
            throw new NotFoundError('ledger_entry', entryId);
        return JSON.parse(row.snapshot_json) as LedgerEntry;
    }
    async currentEffects(householdId: string): Promise<LedgerEffect[]> {
        const rows = await this.database.prepare(`SELECT e.entry_id,e.version,e.member_id,e.currency,e.amount_minor FROM ledger_entries h JOIN ledger_effects e ON e.household_id=h.household_id AND e.entry_id=h.id AND e.version=h.version AND e.effect_kind='snapshot' WHERE h.household_id=? AND h.lifecycle='effective' ORDER BY h.id,e.member_id`).bind(householdId).all<{
            entry_id: string;
            version: number;
            member_id: string;
            currency: LedgerEffect['currency'];
            amount_minor: number;
        }>();
        return rows.results.map(r => ({ entryId: r.entry_id, version: r.version, memberId: r.member_id, currency: r.currency, amountMinor: r.amount_minor }));
    }
    async history(householdId: string, entryId: string): Promise<StoredLedgerRevision[]> {
        const results = await this.database.batch([
            this.database.prepare('SELECT * FROM ledger_revisions WHERE household_id=? AND entry_id=? ORDER BY version').bind(householdId, entryId),
            this.database.prepare("SELECT * FROM ledger_effects WHERE household_id=? AND entry_id=? AND effect_kind<>'snapshot' ORDER BY version,CASE effect_kind WHEN 'reversal' THEN 0 ELSE 1 END,member_id").bind(householdId, entryId),
        ]);
        type RevisionRow = {
            version: number;
            actor_id: string;
            origin: StoredLedgerRevision['origin'];
            operation_id: string;
            action: StoredLedgerRevision['action'];
            accepted_at: string;
            snapshot_json: string;
        };
        type EffectRow = {
            version: number;
            member_id: string;
            currency: LedgerEffect['currency'];
            amount_minor: number;
            effect_kind: 'reversal' | 'replacement';
        };
        const transitions = results[1]!.results as EffectRow[];
        return (results[0]!.results as RevisionRow[]).map(r => ({ entryId, version: r.version, actorId: r.actor_id, origin: r.origin, operationId: r.operation_id, action: r.action, acceptedAt: r.accepted_at, snapshot: JSON.parse(r.snapshot_json) as LedgerEntry, transitions: transitions.filter(e => e.version === r.version).map(e => ({ entryId, version: e.version, memberId: e.member_id, currency: e.currency, amountMinor: e.amount_minor, effectKind: e.effect_kind })) }));
    }
    async accept(proposal: LedgerAcceptance): Promise<LedgerEntry> {
        const { command, before, after, revision } = proposal;
        const h = after.householdId, id = after.id, version = after.version;
        const guard = this.acceptanceGuard(proposal);
        const statements = [commandGuard(this.database, command, 1, guard.sql, guard.values)];
        if (before)
            statements.push(this.database.prepare('UPDATE ledger_entries SET version=?,lifecycle=?,currency=?,total_minor=?,updated_at=? WHERE household_id=? AND id=?').bind(version, after.lifecycle, after.intent.currency, after.intent.totalMinor, after.updatedAt, h, id));
        else
            statements.push(this.database.prepare('INSERT INTO ledger_entries(household_id,id,kind,version,lifecycle,currency,total_minor,expense_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(h, id, after.intent.kind, version, after.lifecycle, after.intent.currency, after.intent.totalMinor, after.intent.kind === 'refund' ? after.intent.expenseId : null, after.createdAt, after.updatedAt));
        statements.push(
            this.database.prepare(`INSERT INTO ledger_revisions
                (household_id,entry_id,version,actor_id,origin,operation_id,action,accepted_at,snapshot_json)
                VALUES(?,?,?,?,?,?,?,?,?)`)
                .bind(h, id, version, revision.actorId, revision.origin, revision.operationId,
                    revision.action, revision.acceptedAt, JSON.stringify(after)),
            this.database.prepare(`INSERT INTO ledger_allocations
                (household_id,entry_id,version,side,position,member_id,amount_minor)
                SELECT ?,?,?,json_extract(value,'$.side'),json_extract(value,'$.position'),
                    json_extract(value,'$.memberId'),json_extract(value,'$.amountMinor')
                FROM json_each(?)`)
                .bind(h, id, version, JSON.stringify([
                    ...after.payers.map((p, position) => ({ ...p, position, side: 'payer' })),
                    ...after.shares.map((p, position) => ({ ...p, position, side: 'share' })),
                ])),
            this.database.prepare(`INSERT INTO ledger_effects
                (household_id,entry_id,version,effect_kind,member_id,currency,amount_minor)
                SELECT ?,?,?,json_extract(value,'$.effectKind'),json_extract(value,'$.memberId'),
                    json_extract(value,'$.currency'),json_extract(value,'$.amountMinor')
                FROM json_each(?)`)
                .bind(h, id, version, JSON.stringify([
                    ...effects(after).map(e => ({ ...e, effectKind: 'snapshot' })),
                    ...revision.transitions,
                ])),
            this.database.prepare(`INSERT INTO ledger_financial_revisions(household_id,revision)
                VALUES(?,1) ON CONFLICT(household_id) DO UPDATE SET revision=revision+1`).bind(h),
        );
        if (!before && after.source) {
            const source = after.source;
            statements.push(this.database.prepare(`INSERT INTO ledger_sources(household_id,entry_id,rule_id,rule_version,period,period_start,period_end,snapshot_json) VALUES(?,?,?,?,?,?,?,?)`)
                .bind(h, id, source.ruleId, source.ruleVersion, source.period, source.periodStart, source.periodEnd, JSON.stringify(source)));
        }
        command.changes = [{ field: 'ledger_entry', before, after, transitions: revision.transitions }];
        return commitCommand(this.database, command, after, id, after.updatedAt, statements, async () => {
            // commitCommand rechecks the exact action before invoking this callback.
            if (before) {
                const current = await this.getEntry(h, id);
                await this.authorize(command.context, command.policyAction);
                if (current.version !== before.version)
                    throw new ConflictError('ledger_entry', id, before.version, current.version, current);
            }
            if (!before && after.source) {
                const existing = await this.database.prepare('SELECT entry_id FROM ledger_sources WHERE household_id=? AND rule_id=? AND period_start=?').bind(h, after.source.ruleId, after.source.periodStart).first<{entry_id: string}>();
                if (existing) {
                    const entry = await this.getEntry(h, existing.entry_id);
                    await this.authorize(command.context, command.policyAction);
                    throw new ConflictError('ledger_source', entry.id, 0, entry.version, entry);
                }
            }
            const check = await this.database.prepare(`SELECT (${guard.sql}) AS admitted`).bind(...guard.values).first<{
                admitted: number;
            }>();
            if (!check?.admitted)
                throw new ValidationError('entry', 'Current lifecycle, participant eligibility, linked credit capacity, recurring rule, financial capacity or version limit prevents this change');
        });
    }
    private acceptanceGuard({ before, after }: LedgerAcceptance): {
        sql: string;
        values: (string | number | null)[];
    } {
        const members = after.intent.kind === 'payment' ? [after.intent.senderId, after.intent.receiverId] : [...new Set([...after.payers, ...after.shares].map(p => p.memberId))];
        const retained = after.intent.kind !== 'expense' ? members : before ? [...new Set([...before.payers, ...before.shares].map(p => p.memberId))] : [];
        const newTotal = after.lifecycle === 'effective' ? after.intent.totalMinor : 0;
        const sql = `SELECT (
   ${before ? "EXISTS(SELECT 1 FROM ledger_entries WHERE household_id=? AND id=? AND version=? AND version<9007199254740991 AND lifecycle=?)" : "NOT EXISTS(SELECT 1 FROM ledger_entries WHERE household_id=? AND id=?)"}
   AND COALESCE((SELECT revision FROM ledger_financial_revisions WHERE household_id=?),0)<9007199254740991
   AND NOT EXISTS(SELECT 1 FROM json_each(?) p LEFT JOIN members m ON m.household_id=? AND m.id=p.value WHERE m.id IS NULL OR (m.archived_at IS NOT NULL AND p.value NOT IN(SELECT value FROM json_each(?))))
   AND COALESCE((SELECT SUM(total_minor) FROM ledger_entries WHERE household_id=? AND lifecycle='effective' AND currency=? AND id<>?),0)<=9007199254740991-?
   ${before && before.intent.currency !== after.intent.currency ? "AND COALESCE((SELECT SUM(total_minor) FROM ledger_entries WHERE household_id=? AND lifecycle='effective' AND currency=? AND id<>?),0)<=9007199254740991" : ""}
  )`;
        const base = { sql, values: [...(before ? [after.householdId, after.id, before.version, before.lifecycle] : [after.householdId, after.id]), after.householdId, JSON.stringify(members), after.householdId, JSON.stringify(retained), after.householdId, after.intent.currency, after.id, newTotal, ...(before && before.intent.currency !== after.intent.currency ? [after.householdId, before.intent.currency, after.id] : [])] };
        const guards: Array<{ sql: string; values: (string | number | null)[] }> = [base];
        if (after.intent.kind !== 'payment') guards.push(this.creditGuard(after));
        if (!before && after.source) {
            const source = after.source;
            guards.push({ sql: `SELECT EXISTS(SELECT 1 FROM expense_rules WHERE household_id=? AND id=? AND version=? AND archived_at IS NULL AND currency=? AND amount_minor=? AND cadence_unit=? AND cadence_interval=? AND anchor_date=?) AND NOT EXISTS(SELECT 1 FROM ledger_sources WHERE household_id=? AND rule_id=? AND period_start=?)`, values: [after.householdId, source.ruleId, source.ruleVersion, source.snapshot.currency, source.snapshot.totalMinor, source.snapshot.cadence.unit, source.snapshot.cadence.interval, source.snapshot.cadence.anchorDate, after.householdId, source.ruleId, source.periodStart] });
        }
        return { sql: 'SELECT ' + guards.map(g => `(${g.sql})`).join(' AND '), values: guards.flatMap(g => g.values) };
    }
    /** Evaluate the projected original and every effective linked credit in the same write snapshot. */
    private creditGuard(after: LedgerEntry): { sql: string; values: (string | number | null)[] } {
        const originalId = after.intent.kind === 'refund' ? after.intent.expenseId : after.id;
        return { sql: `WITH
          proposed AS (SELECT ? AS snapshot_json),
          original AS (
            ${after.intent.kind === 'expense' ? "SELECT snapshot_json FROM proposed" : "SELECT r.snapshot_json FROM ledger_entries h JOIN ledger_revisions r ON r.household_id=h.household_id AND r.entry_id=h.id AND r.version=h.version WHERE h.household_id=? AND h.id=? AND h.kind='expense'"}
          ),
          credits AS (
            SELECT r.snapshot_json FROM ledger_entries h JOIN ledger_revisions r ON r.household_id=h.household_id AND r.entry_id=h.id AND r.version=h.version
            WHERE h.household_id=? AND h.expense_id=? AND h.lifecycle='effective' AND h.id<>?
            ${after.intent.kind === 'refund' && after.lifecycle === 'effective' ? 'UNION ALL SELECT snapshot_json FROM proposed' : ''}
          ),
          credit_allocations AS (
            SELECT 'payer' AS side,json_extract(p.value,'$.memberId') AS member_id,json_extract(p.value,'$.amountMinor') AS amount FROM credits c,json_each(c.snapshot_json,'$.payers') p
            UNION ALL SELECT 'share',json_extract(p.value,'$.memberId'),json_extract(p.value,'$.amountMinor') FROM credits c,json_each(c.snapshot_json,'$.shares') p
          ),
          original_allocations AS (
            SELECT 'payer' AS side,json_extract(p.value,'$.memberId') AS member_id,json_extract(p.value,'$.amountMinor') AS amount FROM original o,json_each(o.snapshot_json,'$.payers') p
            UNION ALL SELECT 'share',json_extract(p.value,'$.memberId'),json_extract(p.value,'$.amountMinor') FROM original o,json_each(o.snapshot_json,'$.shares') p
          )
          SELECT NOT EXISTS(SELECT 1 FROM credits) OR (
            EXISTS(SELECT 1 FROM original WHERE json_extract(snapshot_json,'$.lifecycle')='effective' AND json_extract(snapshot_json,'$.intent.kind')='expense'
              AND json_extract(snapshot_json,'$.intent.totalMinor') >= (SELECT COALESCE(SUM(json_extract(snapshot_json,'$.intent.totalMinor')),0) FROM credits))
            AND NOT EXISTS(SELECT 1 FROM credits c WHERE json_extract(c.snapshot_json,'$.intent.currency')<>(SELECT json_extract(snapshot_json,'$.intent.currency') FROM original))
            AND NOT EXISTS(SELECT 1 FROM credit_allocations c LEFT JOIN original_allocations o ON o.side=c.side AND o.member_id=c.member_id GROUP BY c.side,c.member_id HAVING o.member_id IS NULL OR SUM(c.amount)>o.amount)
          )`, values: [JSON.stringify(after), ...(after.intent.kind === 'expense' ? [] : [after.householdId, originalId]), after.householdId, originalId, after.id] };
    }
}
