import { z } from 'zod';
import { digest } from '../auth/crypto';
import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import { HomeOSError, NotFoundError, ValidationError } from '../platform/errors';
import { decimalMoney } from '../../../../shared/ledger-money';
import type { LedgerComment, LedgerEntry, LedgerPage, StoredLedgerRevision } from './model';
import type { BalanceTotal, LedgerQueryRepository, MemberBalance, OperationStatus, QueryFilter, QueryItem, QueryKind, RefundCapacity, RepaymentSuggestion, SpendingGroup, SpendingTotal, StatementExport, StatementMovement, StatementPage } from './query-repository';
import { balanceQueryInput, entryQueryInput, exportQueryInput, ledgerPageInput, parseQuery, repaymentQueryInput, statementQueryInput, summaryQueryInput } from './query-validation';
import { calendarDate, ledgerId } from './validation';
export type * from './query-repository';

const DOMAIN = 'home-os:ledger-query-cursor:v1\n';
const signedMinor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const statementCursor = z.object({
  after: z.tuple([calendarDate, ledgerId]), runningMinor: signedMinor,
  totals: z.object({ openingMinor: signedMinor, movementMinor: signedMinor, closingMinor: signedMinor,
    movementCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
}).strict().refine(value => BigInt(value.totals.openingMinor) + BigInt(value.totals.movementMinor) === BigInt(value.totals.closingMinor), 'Invalid statement totals');
const cursorPayload = z.object({
  v: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), after: z.tuple([z.string().max(40), ledgerId]).optional(),
  statement: statementCursor.optional(),
}).strict();
type Cursor = z.infer<typeof cursorPayload>;
const bytes = (value: string) => new TextEncoder().encode(value);
function encode(value: Uint8Array): string { return btoa(Array.from(value, v => String.fromCharCode(v)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor encoding');
  const result = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), v => v.charCodeAt(0));
  if (encode(result) !== value) throw new Error('Noncanonical cursor encoding');
  return result;
}
function canonical(value: object) { return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)))); }
function quoteCSV(value: string, humanText = false): string {
  const safe = humanText && /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export class LedgerRevisionChangedError extends HomeOSError {
  constructor() { super('The ledger changed. Restart this query to use one financial basis.', 'ledger_revision_changed', 409); }
}

/** Public disclosure boundary. The injected existing server secret is domain separated for cursors. */
export class LedgerQueries {
  private readonly key: Promise<CryptoKey>;
  constructor(readonly repository: LedgerQueryRepository, cursorSecret: string) {
    if (!cursorSecret) throw new Error('A stable server secret is required for ledger cursors');
    this.key = crypto.subtle.importKey('raw', bytes(cursorSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  }
  async entries(context: CommandContext, raw: unknown = {}): Promise<LedgerPage<LedgerEntry> & { totals: SpendingTotal[] }> {
    const query = parseQuery(entryQueryInput, raw);
    const result = await this.page<LedgerEntry>(context, 'entries', 'ledger_list', query);
    return { ...result.page, totals: result.snapshot.spendingTotals! };
  }
  async getEntry(context: CommandContext, entryId: string): Promise<{ entry: LedgerEntry; revision: number; refundCapacity?: RefundCapacity }> {
    const result = await this.page<LedgerEntry>(context, 'detail', 'ledger_get', { entryId: parseQuery(ledgerId, entryId), limit: 1 });
    return { entry: result.page.items[0]!, revision: result.page.revision, ...(result.snapshot.refundCapacity ? { refundCapacity: result.snapshot.refundCapacity } : {}) };
  }
  async balances(context: CommandContext, raw: unknown = {}): Promise<LedgerPage<MemberBalance> & { totals: BalanceTotal[] }> {
    const result = await this.page<MemberBalance>(context, 'balances', 'ledger_balances', parseQuery(balanceQueryInput, raw));
    return { ...result.page, totals: result.snapshot.balanceTotals! };
  }
  async repayments(context: CommandContext, raw: unknown = {}): Promise<LedgerPage<RepaymentSuggestion> & { totals: BalanceTotal[]; basis: 'deterministic-net-balances' }> {
    const result = await this.page<RepaymentSuggestion>(context, 'repayments', 'ledger_balances', parseQuery(repaymentQueryInput, raw));
    return { ...result.page, totals: result.snapshot.balanceTotals!, basis: 'deterministic-net-balances' };
  }
  async summaries(context: CommandContext, raw: unknown = {}): Promise<LedgerPage<SpendingGroup> & { totals: SpendingTotal[]; groupBy: 'month' | 'category' }> {
    const query = parseQuery(summaryQueryInput, raw);
    const result = await this.page<SpendingGroup>(context, 'summaries', 'ledger_list', query);
    return { ...result.page, totals: result.snapshot.spendingTotals!, groupBy: query.groupBy };
  }
  async comments(context: CommandContext, entryId: string, raw: unknown = {}): Promise<LedgerPage<LedgerComment>> {
    return (await this.page<LedgerComment>(context, 'comments', 'ledger_get', { ...parseQuery(ledgerPageInput, raw), entryId: parseQuery(ledgerId, entryId) })).page;
  }
  async history(context: CommandContext, entryId: string, raw: unknown = {}): Promise<LedgerPage<StoredLedgerRevision>> {
    return (await this.page<StoredLedgerRevision>(context, 'history', 'ledger_history', { ...parseQuery(ledgerPageInput, raw), entryId: parseQuery(ledgerId, entryId) })).page;
  }
  async statement(context: CommandContext, raw: unknown): Promise<StatementPage> {
    const query = parseQuery(statementQueryInput, raw);
    const result = await this.page<StatementMovement>(context, 'statement', 'ledger_statements', query);
    return { ...result.page, ...result.snapshot.statementTotals!, scope: { memberId: query.memberId, currency: query.currency, from: query.from ?? null, to: query.to ?? null, basis: 'current-effective' } };
  }
  async export(context: CommandContext, raw: unknown): Promise<StatementExport> {
    const query = parseQuery(exportQueryInput, raw);
    const result = await this.page<StatementMovement>(context, 'export', 'ledger_export', query);
    const rows = result.page.items;
    const csv = query.format === 'csv' ? [
      ['entry_id', 'version', 'date', 'kind', 'description', 'currency', 'amount', 'running_balance'].map(v => quoteCSV(v)).join(','),
      ...rows.map(row => [quoteCSV(row.entryId, true), quoteCSV(String(row.version)), quoteCSV(row.date), quoteCSV(row.kind), quoteCSV(row.description, true), quoteCSV(row.currency), quoteCSV(decimalMoney(row.amountMinor, row.currency)), quoteCSV(decimalMoney(row.runningMinor, row.currency))].join(',')),
    ].join('\r\n') + '\r\n' : undefined;
    return {
      ...result.page, ...result.snapshot.statementTotals!, scope: { memberId: query.memberId, currency: query.currency, from: query.from ?? null, to: query.to ?? null, basis: 'current-effective' },
      format: query.format, ...(csv !== undefined ? { csv } : {}), maxMovementRows: 10000, maxBytes: 8388608,
      requiresNarrowerRange: result.snapshot.statementTotals!.movementCount > 10000,
    };
  }
  async operationStatus(context: CommandContext, operationId: string): Promise<OperationStatus> {
    const result = await this.page<OperationStatus>(context, 'operation', 'ledger_get', { operationId: parseQuery(ledgerId, operationId), limit: 1 });
    return result.page.items[0] ?? { status: 'unknown' };
  }

  private async page<T extends QueryItem>(context: CommandContext, kind: QueryKind, action: Action, query: QueryFilter & { limit: number; cursor?: string }) {
    await this.repository.authorize(context, action);
    const { limit, cursor: token, ...filter } = query;
    const binding = await digest(DOMAIN + canonical({ actorId: context.actorId, householdId: context.householdId, kind, filter: canonical(filter), limit }));
    const statement = kind === 'statement' || kind === 'export';
    try {
      const cursor = token ? await this.readCursor(token, binding, kind) : undefined;
      if (cursor?.statement && ((filter.from && cursor.statement.after[0] < filter.from) || (filter.to && cursor.statement.after[0] > filter.to))) throw new ValidationError('cursor', 'Invalid cursor or different query scope');
      const snapshot = await this.repository.read(context, { kind, filter, limit, offset: statement ? 0 : cursor?.offset ?? 0, ...(cursor?.after ? { afterComment: cursor.after } : {}), ...(cursor?.statement ? { statement: { ...cursor.statement, revision: cursor.revision! } } : {}) }, action);
      if (!snapshot.subjectExists) throw new NotFoundError(filter.entryId ? 'ledger_entry' : 'member', filter.entryId ?? filter.memberId!);
      if (cursor && kind !== 'comments' && cursor.revision !== snapshot.revision) throw new LedgerRevisionChangedError();
      const items = snapshot.items.slice(0, limit) as T[];
      let nextCursor: string | null = null;
      if (snapshot.items.length > limit) {
        const last = items.at(-1)!;
        nextCursor = await this.writeCursor({ v: 1, binding, revision: kind === 'comments' ? null : snapshot.revision, offset: (cursor?.offset ?? 0) + items.length,
          ...(kind === 'comments' ? { after: [(last as LedgerComment).acceptedAt, (last as LedgerComment).id] as [string, string] } : {}),
          ...(statement ? { statement: { after: [(last as StatementMovement).date, (last as StatementMovement).entryId] as [string, string], runningMinor: (last as StatementMovement).runningMinor, totals: snapshot.statementTotals! } } : {}),
        });
      }
      return { page: { items, nextCursor, revision: snapshot.revision }, snapshot };
    } finally {
      // Recheck even missing subjects, stale cursors and repository failures before any disclosure.
      await this.repository.authorize(context, action);
    }
  }
  private async writeCursor(payload: Cursor): Promise<string> {
    const body = encode(bytes(JSON.stringify(payload)));
    const signature = await crypto.subtle.sign('HMAC', await this.key, bytes(DOMAIN + body));
    return `${body}.${encode(new Uint8Array(signature))}`;
  }
  private async readCursor(token: string, binding: string, kind: QueryKind): Promise<Cursor> {
    try {
      if (token.length > 4096) throw new Error('Cursor too long');
      const parts = token.split('.');
      if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await this.key, decode(parts[1]!), bytes(DOMAIN + parts[0]!))) throw new Error('Invalid cursor signature');
      const payload = cursorPayload.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[0]!))));
      const comments = kind === 'comments', statement = kind === 'statement' || kind === 'export';
      if (payload.binding !== binding || (comments ? payload.revision !== null || !payload.after : payload.revision === null || payload.after !== undefined)
        || (statement ? !payload.statement || payload.offset <= 0 || payload.offset >= payload.statement.totals.movementCount : payload.statement !== undefined)) throw new Error('Different cursor scope');
      return payload;
    } catch { throw new ValidationError('cursor', 'Invalid cursor or different query scope'); }
  }
}
