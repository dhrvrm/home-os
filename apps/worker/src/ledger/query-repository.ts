import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import type { Currency, LedgerComment, LedgerEntry, LedgerPage, StoredLedgerRevision } from './model';

export interface SpendingTotal { currency: Currency; expenseMinor: number; creditMinor: number; paymentMinor: number; netSpendingMinor: number; count: number }
export interface BalanceTotal { currency: Currency; paidMinor: number; shareMinor: number; sentMinor: number; receivedMinor: number; netMinor: number }
export interface MemberBalance extends BalanceTotal { memberId: string; displayName: string; active: boolean }
export interface RepaymentSuggestion { currency: Currency; senderId: string; receiverId: string; amountMinor: number }
export interface RefundPersonCapacity { memberId: string; originalMinor: number; creditedMinor: number; remainingMinor: number }
export interface RefundCapacity { expenseId: string; available: boolean; totalMinor: number; creditedMinor: number; remainingMinor: number; payers: RefundPersonCapacity[]; shares: RefundPersonCapacity[] }
export interface SpendingGroup extends SpendingTotal { group: string }
export interface StatementMovement { entryId: string; version: number; date: string; kind: LedgerEntry['intent']['kind']; description: string; currency: Currency; amountMinor: number; runningMinor: number }
export interface StatementTotals { openingMinor: number; movementMinor: number; closingMinor: number; movementCount: number }
export interface StatementScope { memberId: string; currency: Currency; from: string | null; to: string | null; basis: 'current-effective' }
export interface StatementPage extends LedgerPage<StatementMovement>, StatementTotals { scope: StatementScope }
export interface StatementExport extends StatementPage { format: 'csv' | 'json'; csv?: string; maxMovementRows: 10000; maxBytes: 8388608; requiresNarrowerRange: boolean }
export type OperationStatus = { status: 'unknown' } | { status: 'accepted'; entryId: string; version: number; action: string; commentId?: string };
export type QueryKind = 'entries' | 'detail' | 'balances' | 'repayments' | 'summaries' | 'statement' | 'export' | 'comments' | 'history' | 'operation';
export interface QueryFilter {
  from?: string; to?: string; currency?: Currency; memberId?: string; category?: string; search?: string;
  lifecycle?: 'effective' | 'void' | 'all'; kind?: LedgerEntry['intent']['kind']; groupBy?: 'month' | 'category';
  entryId?: string; operationId?: string; format?: 'csv' | 'json';
}
/** Internal bounded read request. Each result is obtained from one database snapshot. */
export interface StatementContinuation {
  revision: number;
  after: [string, string];
  runningMinor: number;
  totals: StatementTotals;
}
export interface LedgerRead { kind: QueryKind; filter: QueryFilter; limit: number; offset: number; afterComment?: [string, string]; statement?: StatementContinuation }
export type QueryItem = LedgerEntry | LedgerComment | StoredLedgerRevision | MemberBalance | RepaymentSuggestion | SpendingGroup | StatementMovement | OperationStatus;
export interface QuerySnapshot {
  revision: number; subjectExists: boolean; items: QueryItem[];
  spendingTotals?: SpendingTotal[]; balanceTotals?: BalanceTotal[]; statementTotals?: StatementTotals;
  refundCapacity?: RefundCapacity;
}
export interface LedgerQueryRepository {
  authorize(context: CommandContext, action: Action): Promise<void>;
  /** Implementations must bound rows and obtain basis, aggregates and rows atomically. */
  read(context: CommandContext, request: LedgerRead, action: Action): Promise<QuerySnapshot>;
}
