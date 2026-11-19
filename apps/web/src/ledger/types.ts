// Type-only dependency keeps the browser free of Worker and storage runtime imports.
export type { Currency, Adjustment, BillItem, ItemizedIntent, ItemizedResult, Share, SplitIntent, SplitParticipant } from "../../../../shared/ledger-money";
export type { ExpenseInput, RefundInput, PaymentInput, FinancialInput, LedgerCommand, ResolvedExpense, LedgerEntry, LedgerRevision, LedgerComment, LedgerEffect, LedgerLifecycle, LedgerOrigin, LedgerPage, RecurringPostingSource } from "../../../worker/src/ledger/model";
export type { StoredLedgerRevision } from "../../../worker/src/ledger/model";
import type { Currency, LedgerCommand, LedgerComment, LedgerEntry, LedgerPage } from "../../../worker/src/ledger/model";
export type CommandResult = { status: "accepted"; entry: LedgerEntry } | { status: "accepted"; comment: LedgerComment };
export interface AcceptedReference { status: "accepted"; entryId: string; version: number; action: string; commentId?: string }
// Transport views deliberately avoid the repository's server authority dependencies.
export interface SpendingTotal { currency: Currency; expenseMinor: number; creditMinor: number; paymentMinor: number; netSpendingMinor: number; count: number }
export interface BalanceTotal { currency: Currency; paidMinor: number; shareMinor: number; sentMinor: number; receivedMinor: number; netMinor: number }
export interface MemberBalance extends BalanceTotal { memberId: string; displayName: string; active: boolean }
export interface RepaymentSuggestion { currency: Currency; senderId: string; receiverId: string; amountMinor: number }
export interface SpendingGroup extends SpendingTotal { group: string }
export interface RefundPersonCapacity { memberId: string; originalMinor: number; creditedMinor: number; remainingMinor: number }
export interface RefundCapacity { expenseId: string; available: boolean; totalMinor: number; creditedMinor: number; remainingMinor: number; payers: RefundPersonCapacity[]; shares: RefundPersonCapacity[] }
export interface StatementMovement { entryId: string; version: number; date: string; kind: LedgerEntry["intent"]["kind"]; description: string; currency: Currency; amountMinor: number; runningMinor: number }
export interface StatementScope { memberId: string; currency: Currency; from: string | null; to: string | null; basis: "current-effective" }
export interface StatementPage extends LedgerPage<StatementMovement> { scope: StatementScope; openingMinor: number; movementMinor: number; closingMinor: number; movementCount: number }
export interface StatementExport extends StatementPage { format: "csv" | "json"; csv?: string; maxMovementRows: 10000; maxBytes: 8388608; requiresNarrowerRange: boolean }
export type OperationStatus = { status: "unknown" } | AcceptedReference;

type WithoutOperationId<T> = T extends { operationId: string } ? Omit<T, "operationId"> : never;
export type LedgerCommandDraft = WithoutOperationId<LedgerCommand>;
