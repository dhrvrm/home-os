import { assertAuthority, authorityDenied, authorityPredicate } from '../auth/authority';
import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import type { LedgerEntry, StoredLedgerRevision } from './model';
import type { BalanceTotal, LedgerQueryRepository, LedgerRead, QueryFilter, QueryItem, QuerySnapshot, RefundCapacity, RefundPersonCapacity, SpendingTotal, StatementTotals } from './query-repository';

type Binding = string | number | null;
interface SQL { text: string; values: Binding[] }
const FACTS = `WITH facts AS (
 SELECT h.*,r.snapshot_json,json_extract(r.snapshot_json,'$.intent.date') AS date,
 COALESCE(json_extract(r.snapshot_json,'$.intent.category'),json_extract(original_revision.snapshot_json,'$.intent.category'),'') AS category,
 COALESCE(json_extract(r.snapshot_json,'$.intent.description'),json_extract(r.snapshot_json,'$.intent.method'),'') AS description
 FROM ledger_entries h JOIN ledger_revisions r ON r.household_id=h.household_id AND r.entry_id=h.id AND r.version=h.version
 LEFT JOIN ledger_entries original ON original.household_id=h.household_id AND original.id=h.expense_id
 LEFT JOIN ledger_revisions original_revision ON original_revision.household_id=original.household_id AND original_revision.entry_id=original.id AND original_revision.version=original.version
 WHERE h.household_id=?
)`;
function selection(filter: QueryFilter, includeMember = true): SQL {
  const conditions: string[] = [];
  const values: Binding[] = [];
  if (filter.lifecycle !== 'all') { conditions.push('f.lifecycle=?'); values.push(filter.lifecycle ?? 'effective'); }
  for (const [key, operator, value] of [
    ['date', '>=', filter.from], ['date', '<=', filter.to], ['currency', '=', filter.currency],
    ['category', '=', filter.category], ['kind', '=', filter.kind],
  ] as const) if (value !== undefined) { conditions.push(`f.${key}${operator}?`); values.push(value); }
  if (filter.search) {
    // instr treats %, _, quotes and backslashes as ordinary text, never LIKE syntax.
    conditions.push("instr(lower(f.description||' '||COALESCE(json_extract(f.snapshot_json,'$.intent.notes'),'')),lower(?))>0"); values.push(filter.search);
  }
  if (includeMember && filter.memberId) {
    conditions.push(`(EXISTS(SELECT 1 FROM ledger_allocations a WHERE a.household_id=f.household_id AND a.entry_id=f.id AND a.version=f.version AND a.member_id=?) OR json_extract(f.snapshot_json,'$.intent.senderId')=? OR json_extract(f.snapshot_json,'$.intent.receiverId')=?)`);
    values.push(filter.memberId, filter.memberId, filter.memberId);
  }
  return { text: conditions.join(' AND ') || '1', values };
}
const SPENDING_TOTALS = `currency,
 COALESCE(SUM(CASE WHEN kind='expense' THEN total_minor ELSE 0 END),0) AS expenseMinor,
 COALESCE(SUM(CASE WHEN kind='refund' THEN total_minor ELSE 0 END),0) AS creditMinor,
 COALESCE(SUM(CASE WHEN kind='payment' THEN total_minor ELSE 0 END),0) AS paymentMinor,
 COALESCE(SUM(CASE kind WHEN 'expense' THEN total_minor WHEN 'refund' THEN -total_minor ELSE 0 END),0) AS netSpendingMinor,COUNT(*) AS count`;
// Components explain the selected snapshot; net remains the persisted snapshot effect.
const BALANCES = `, component AS (
 SELECT a.member_id AS memberId,f.currency,
 CASE WHEN a.side='payer' THEN CASE f.kind WHEN 'refund' THEN -a.amount_minor ELSE a.amount_minor END ELSE 0 END AS paidMinor,
 CASE WHEN a.side='share' THEN CASE f.kind WHEN 'refund' THEN -a.amount_minor ELSE a.amount_minor END ELSE 0 END AS shareMinor,
 0 AS sentMinor,0 AS receivedMinor,0 AS netMinor
 FROM facts f JOIN ledger_allocations a ON a.household_id=f.household_id AND a.entry_id=f.id AND a.version=f.version
 WHERE f.lifecycle='effective' AND f.kind IN('expense','refund')
 UNION ALL
 SELECT e.member_id,f.currency,0,0,
 CASE WHEN f.kind='payment' AND e.member_id=json_extract(f.snapshot_json,'$.intent.senderId') THEN f.total_minor ELSE 0 END,
 CASE WHEN f.kind='payment' AND e.member_id=json_extract(f.snapshot_json,'$.intent.receiverId') THEN f.total_minor ELSE 0 END,e.amount_minor
 FROM facts f JOIN ledger_effects e ON e.household_id=f.household_id AND e.entry_id=f.id AND e.version=f.version AND e.effect_kind='snapshot'
 WHERE f.lifecycle='effective'
), balances AS (
 SELECT memberId,currency,SUM(paidMinor) AS paidMinor,SUM(shareMinor) AS shareMinor,SUM(sentMinor) AS sentMinor,SUM(receivedMinor) AS receivedMinor,SUM(netMinor) AS netMinor
 FROM component GROUP BY currency,memberId
)`;

/** Read-only D1 batches establish one snapshot for basis, complete SQL totals and bounded rows. */
export class D1LedgerQueryRepository implements LedgerQueryRepository {
  constructor(private readonly database: D1Database) {}
  authorize(context: CommandContext, action: Action) { return assertAuthority(this.database, context, action); }

  async read(context: CommandContext, request: LedgerRead, action: Action): Promise<QuerySnapshot> {
    const { kind, filter, limit, offset } = request;
    const predicate = authorityPredicate(context, action);
    const subject = filter.entryId ? { sql: 'EXISTS(SELECT 1 FROM ledger_entries WHERE household_id=? AND id=?)', values: [context.householdId, filter.entryId] }
      : filter.memberId ? { sql: 'EXISTS(SELECT 1 FROM members WHERE household_id=? AND id=?)', values: [context.householdId, filter.memberId] }
      : { sql: '1', values: [] };
    const statements = [this.database.prepare(`SELECT (${predicate.sql}) AS admitted,COALESCE((SELECT revision FROM ledger_financial_revisions WHERE household_id=?),0) AS revision,(${subject.sql}) AS subjectExists`).bind(...predicate.values, context.householdId, ...subject.values)];
    const prepare = (sql: string, values: Binding[] = []) => this.database.prepare(sql).bind(...values);
    const facts = (sql: string, values: Binding[] = []) => prepare(`${FACTS}${sql}`, [context.householdId, ...values]);
    let aggregate: 'spendingTotals' | 'balanceTotals' | 'statementTotals' | undefined;
    if (kind === 'entries' || kind === 'summaries') {
      const scope = selection(filter);
      const effective = kind === 'entries' ? `(${scope.text}) AND f.lifecycle='effective'` : `${scope.text} AND f.kind<>'payment'`;
      aggregate = 'spendingTotals';
      statements.push(facts(` SELECT ${SPENDING_TOTALS} FROM facts f WHERE ${effective} GROUP BY currency ORDER BY currency LIMIT 5`, scope.values));
      if (kind === 'entries') statements.push(facts(` SELECT snapshot_json FROM facts f WHERE ${scope.text} ORDER BY date,id LIMIT ? OFFSET ?`, [...scope.values, limit + 1, offset]));
      else {
        const group = filter.groupBy === 'category' ? 'category' : 'substr(date,1,7)';
        statements.push(facts(` SELECT ${SPENDING_TOTALS},${group} AS 'group' FROM facts f WHERE ${effective} GROUP BY currency,${group} ORDER BY currency,${group} LIMIT ? OFFSET ?`, [...scope.values, limit + 1, offset]));
      }
    } else if (kind === 'balances' || kind === 'repayments') {
      aggregate = 'balanceTotals';
      const where = filter.currency ? 'WHERE currency=?' : '';
      const bindings = filter.currency ? [filter.currency] : [];
      statements.push(facts(`${BALANCES} SELECT currency,SUM(paidMinor) AS paidMinor,SUM(shareMinor) AS shareMinor,SUM(sentMinor) AS sentMinor,SUM(receivedMinor) AS receivedMinor,SUM(netMinor) AS netMinor FROM balances ${where} GROUP BY currency ORDER BY currency LIMIT 5`, bindings));
      if (kind === 'balances') {
        const terms = [filter.currency ? 'b.currency=?' : '', filter.memberId ? 'b.memberId=?' : ''].filter(Boolean);
        statements.push(facts(`${BALANCES} SELECT b.*,m.display_name AS displayName,CASE WHEN m.archived_at IS NULL THEN 1 ELSE 0 END AS active FROM balances b JOIN members m ON m.household_id=? AND m.id=b.memberId ${terms.length ? `WHERE ${terms.join(' AND ')}` : ''} ORDER BY b.currency,b.memberId LIMIT ? OFFSET ?`, [context.householdId, ...bindings, ...(filter.memberId ? [filter.memberId] : []), limit + 1, offset]));
      } else statements.push(facts(`${BALANCES}, debtors AS (
        SELECT currency,memberId,-netMinor AS amount,SUM(-netMinor) OVER(PARTITION BY currency ORDER BY memberId ROWS UNBOUNDED PRECEDING) AS finish FROM balances WHERE netMinor<0
      ), creditors AS (
        SELECT currency,memberId,netMinor AS amount,SUM(netMinor) OVER(PARTITION BY currency ORDER BY memberId ROWS UNBOUNDED PRECEDING) AS finish FROM balances WHERE netMinor>0
      ) SELECT d.currency,d.memberId AS senderId,c.memberId AS receiverId,MIN(d.finish,c.finish)-MAX(d.finish-d.amount,c.finish-c.amount) AS amountMinor
      FROM debtors d JOIN creditors c ON c.currency=d.currency AND d.finish>c.finish-c.amount AND c.finish>d.finish-d.amount
      ${filter.currency ? 'WHERE d.currency=?' : ''} ORDER BY d.currency,d.memberId,c.memberId LIMIT ? OFFSET ?`, [...bindings, limit + 1, offset]));
    } else if (kind === 'statement' || kind === 'export') {
      aggregate = 'statementTotals';
      const cte = `, movements AS (
        SELECT f.id AS entryId,f.version,f.date,f.kind,f.description,f.currency,e.amount_minor AS amountMinor
        FROM facts f JOIN ledger_effects e ON e.household_id=f.household_id AND e.entry_id=f.id AND e.version=f.version AND e.effect_kind='snapshot'
        WHERE f.lifecycle='effective' AND e.member_id=? AND f.currency=?
      ), totals AS (SELECT
        COALESCE(SUM(CASE WHEN ? IS NOT NULL AND date<? THEN amountMinor ELSE 0 END),0) AS openingMinor,
        COALESCE(SUM(CASE WHEN (? IS NULL OR date>=?) AND (? IS NULL OR date<=?) THEN amountMinor ELSE 0 END),0) AS movementMinor,
        COALESCE(SUM(CASE WHEN ? IS NULL OR date<=? THEN amountMinor ELSE 0 END),0) AS closingMinor,
        COUNT(CASE WHEN (? IS NULL OR date>=?) AND (? IS NULL OR date<=?) THEN 1 END) AS movementCount FROM movements
      )`;
      const values = [filter.memberId!, filter.currency!, filter.from ?? null, filter.from ?? null, filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null, filter.to ?? null, filter.to ?? null, filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null];
      const statement = (sql: string, extra: (string | number | null)[] = []) => prepare(`${FACTS}${cte}${sql}`, [context.householdId, ...values, ...extra] as Binding[]);
      statements.push(statement(' SELECT * FROM totals'));
      statements.push(statement(` SELECT *, (SELECT openingMinor FROM totals)+SUM(amountMinor) OVER(ORDER BY date,entryId ROWS UNBOUNDED PRECEDING) AS runningMinor FROM movements WHERE (? IS NULL OR date>=?) AND (? IS NULL OR date<=?) ORDER BY date,entryId LIMIT ? OFFSET ?`, [filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null, limit + 1, offset]));
    } else if (kind === 'detail') {
      const capacity = `, source AS (SELECT f.* FROM facts f WHERE f.kind='expense' AND f.id=(SELECT COALESCE(expense_id,id) FROM facts WHERE id=?)),
        credits AS (SELECT f.* FROM facts f JOIN source s ON f.expense_id=s.id WHERE f.lifecycle='effective' AND f.kind='refund')`;
      statements.push(facts(`${capacity} SELECT s.id AS expenseId,s.lifecycle='effective' AS available,s.total_minor AS totalMinor,
        COALESCE((SELECT SUM(total_minor) FROM credits),0) AS creditedMinor,
        CASE WHEN s.lifecycle='effective' THEN s.total_minor-COALESCE((SELECT SUM(total_minor) FROM credits),0) ELSE 0 END AS remainingMinor FROM source s LIMIT 1`, [filter.entryId!]));
      statements.push(facts(`${capacity}, credited AS (
        SELECT a.side,a.member_id,SUM(a.amount_minor) AS amount FROM credits c JOIN ledger_allocations a ON a.household_id=c.household_id AND a.entry_id=c.id AND a.version=c.version GROUP BY a.side,a.member_id
      ) SELECT a.side,a.member_id AS memberId,a.amount_minor AS originalMinor,COALESCE(c.amount,0) AS creditedMinor,
        CASE WHEN s.lifecycle='effective' THEN a.amount_minor-COALESCE(c.amount,0) ELSE 0 END AS remainingMinor
        FROM source s JOIN ledger_allocations a ON a.household_id=s.household_id AND a.entry_id=s.id AND a.version=s.version LEFT JOIN credited c ON c.side=a.side AND c.member_id=a.member_id ORDER BY a.side,a.position LIMIT 24`, [filter.entryId!]));
      statements.push(facts(' SELECT snapshot_json FROM facts WHERE id=? LIMIT 1', [filter.entryId!]));
    } else if (kind === 'comments') {
      const [time, id] = request.afterComment ?? ['', ''];
      statements.push(prepare(`SELECT id,entry_id AS entryId,observed_version AS observedVersion,author_id AS authorId,text,accepted_at AS acceptedAt FROM ledger_comments WHERE household_id=? AND entry_id=? AND (accepted_at>? OR (accepted_at=? AND id>?)) ORDER BY accepted_at,id LIMIT ?`, [context.householdId, filter.entryId!, time, time, id, limit + 1]));
    } else if (kind === 'history') {
      statements.push(prepare(`SELECT r.*,COALESCE((SELECT json_group_array(json_object('entryId',e.entry_id,'version',e.version,'memberId',e.member_id,'currency',e.currency,'amountMinor',e.amount_minor,'effectKind',e.effect_kind)) FROM (SELECT * FROM ledger_effects WHERE household_id=r.household_id AND entry_id=r.entry_id AND version=r.version AND effect_kind<>'snapshot' ORDER BY CASE effect_kind WHEN 'reversal' THEN 0 ELSE 1 END,member_id) e),'[]') AS transitions_json FROM ledger_revisions r WHERE r.household_id=? AND r.entry_id=? ORDER BY r.version LIMIT ? OFFSET ?`, [context.householdId, filter.entryId!, limit + 1, offset]));
    } else {
      // Narrow own references only; no generic receipt payload, fingerprint or other actor's attempt.
      statements.push(prepare(`SELECT entry_id AS entryId,version,action,NULL AS commentId FROM ledger_revisions WHERE household_id=? AND actor_id=? AND operation_id=? UNION ALL SELECT entry_id AS entryId,observed_version AS version,'comment' AS action,id AS commentId FROM ledger_comments WHERE household_id=? AND author_id=? AND operation_id=? LIMIT 1`, [context.householdId, context.actorId, filter.operationId!, context.householdId, context.actorId, filter.operationId!]));
    }
    const results = await this.database.batch<Record<string, unknown>>(statements);
    const header = results[0]!.results[0] as { admitted: number; revision: number; subjectExists: number };
    if (!header.admitted) throw authorityDenied();
    const rawRows = results.at(-1)!.results;
    let items: QueryItem[];
    if (kind === 'entries' || kind === 'detail') items = rawRows.map(row => JSON.parse(row.snapshot_json as string) as LedgerEntry);
    else if (kind === 'history') items = rawRows.map(row => ({
      entryId: row.entry_id, version: row.version, actorId: row.actor_id, origin: row.origin, operationId: row.operation_id,
      action: row.action, acceptedAt: row.accepted_at, snapshot: JSON.parse(row.snapshot_json as string), transitions: JSON.parse(row.transitions_json as string),
    } as StoredLedgerRevision));
    else if (kind === 'balances') items = rawRows.map(row => ({ ...row, active: Boolean(row.active) })) as unknown as QueryItem[];
    else if (kind === 'operation') items = rawRows.map(row => ({ status: 'accepted', entryId: row.entryId, version: row.version, action: row.action, ...(row.commentId ? { commentId: row.commentId } : {}) })) as QueryItem[];
    else items = rawRows as unknown as QueryItem[];
    const capacity = kind === 'detail' ? results[1]!.results[0] : undefined;
    const capacities = kind === 'detail' ? results[2]!.results : [];
    const people = (side: string) => capacities.filter(row => row.side === side).map(({ side: _side, ...row }) => row as unknown as RefundPersonCapacity);
    return {
      revision: header.revision, subjectExists: Boolean(header.subjectExists), items,
      ...(aggregate === 'spendingTotals' ? { spendingTotals: results[1]!.results as unknown as SpendingTotal[] } : {}),
      ...(aggregate === 'balanceTotals' ? { balanceTotals: results[1]!.results as unknown as BalanceTotal[] } : {}),
      ...(aggregate === 'statementTotals' ? { statementTotals: results[1]!.results[0] as unknown as StatementTotals } : {}),
      ...(capacity ? { refundCapacity: { ...capacity, available: Boolean(capacity.available), payers: people('payer'), shares: people('share') } as unknown as RefundCapacity } : {}),
    };
  }
}
