import { assertAuthority } from '../auth/authority';
import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import { ConflictError, NotFoundError, ValidationError } from '../platform/errors';
import { beginCommand, commandGuard, commitCommand, replayCommand } from '../platform/household-command';
import type { LedgerEffect, LedgerEntry, StoredLedgerRevision } from './model';
import type { LedgerAcceptance, LedgerRepository } from './repository';
import { effects } from './allocation';
/** All write guards and retained money are submitted in one D1 transactional batch. */
export class D1LedgerRepository implements LedgerRepository {
    constructor(private readonly database: D1Database) { }
    async begin(context: CommandContext, action: string, entryId: string | undefined, input: unknown) {
        const command = await beginCommand(this.database, context, 'ledger_entry', action, entryId, input);
        return { command, replay: await replayCommand<LedgerEntry>(this.database, command) };
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
        command.changes = [{ field: 'ledger_entry', before, after, transitions: revision.transitions }];
        return commitCommand(this.database, command, after, id, after.updatedAt, statements, async () => {
            // commitCommand rechecks the exact action before invoking this callback.
            if (before) {
                const current = await this.getEntry(h, id);
                if (current.version !== before.version)
                    throw new ConflictError('ledger_entry', id, before.version, current.version, current);
            }
            const check = await this.database.prepare(`SELECT (${guard.sql}) AS admitted`).bind(...guard.values).first<{
                admitted: number;
            }>();
            if (!check?.admitted)
                throw new ValidationError('entry', 'Current lifecycle, participant eligibility, financial capacity or version limit prevents this change');
        });
    }
    private acceptanceGuard({ before, after }: LedgerAcceptance): {
        sql: string;
        values: (string | number | null)[];
    } {
        const members = [...new Set([...after.payers, ...after.shares].map(p => p.memberId))];
        const retained = before ? [...new Set([...before.payers, ...before.shares].map(p => p.memberId))] : [];
        const newTotal = after.lifecycle === 'effective' ? after.intent.totalMinor : 0;
        const sql = `SELECT (
   ${before ? "EXISTS(SELECT 1 FROM ledger_entries WHERE household_id=? AND id=? AND version=? AND version<9007199254740991 AND lifecycle=?)" : "NOT EXISTS(SELECT 1 FROM ledger_entries WHERE household_id=? AND id=?)"}
   AND COALESCE((SELECT revision FROM ledger_financial_revisions WHERE household_id=?),0)<9007199254740991
   AND NOT EXISTS(SELECT 1 FROM json_each(?) p LEFT JOIN members m ON m.household_id=? AND m.id=p.value WHERE m.id IS NULL OR (m.archived_at IS NOT NULL AND p.value NOT IN(SELECT value FROM json_each(?))))
   AND COALESCE((SELECT SUM(total_minor) FROM ledger_entries WHERE household_id=? AND lifecycle='effective' AND currency=? AND id<>?),0)<=9007199254740991-?
   ${before && before.intent.currency !== after.intent.currency ? "AND COALESCE((SELECT SUM(total_minor) FROM ledger_entries WHERE household_id=? AND lifecycle='effective' AND currency=? AND id<>?),0)<=9007199254740991" : ""}
  )`;
        return { sql, values: [...(before ? [after.householdId, after.id, before.version, before.lifecycle] : [after.householdId, after.id]), after.householdId, JSON.stringify(members), after.householdId, JSON.stringify(retained), after.householdId, after.intent.currency, after.id, newTotal, ...(before && before.intent.currency !== after.intent.currency ? [after.householdId, before.intent.currency, after.id] : [])] };
    }
}
