import type { Currency, ItemizedIntent, ItemizedResult, Share, SplitIntent } from "../../../../shared/ledger-money";
export type { Currency, Adjustment, BillItem, ItemizedIntent, ItemizedResult, Share, SplitIntent, SplitParticipant } from "../../../../shared/ledger-money";

/** Client intent excludes household, actor and author: those come from admitted authority. */
export interface ExpenseInput {
  kind: "expense";
  date: string;
  description: string;
  currency: Currency;
  totalMinor: number;
  category?: string;
  notes?: string;
  payers: Share[];
  allocation: { kind: "split"; split: SplitIntent } | ({ kind: "itemized" } & ItemizedIntent);
}
export interface RefundInput {
  kind: "refund";
  expenseId: string;
  date: string;
  description: string;
  currency: Currency;
  totalMinor: number;
  notes?: string;
  /** Returned original payer contributions and credited original beneficiary shares. */
  payers: Share[];
  shares: Share[];
}
export interface PaymentInput {
  kind: "payment";
  date: string;
  currency: Currency;
  totalMinor: number;
  senderId: string;
  receiverId: string;
  method: string;
  reference?: string;
  notes?: string;
}
export type FinancialInput = ExpenseInput | RefundInput | PaymentInput;
export type LedgerCommand = { operationId: string } & (
  | { action: "create"; entry: FinancialInput }
  | { action: "correct"; entryId: string; expectedVersion: number; entry: FinancialInput }
  | { action: "void" | "restore"; entryId: string; expectedVersion: number }
  | { action: "comment"; entryId: string; expectedVersion: number; text: string }
  | { action: "post"; ruleId: string; expectedRuleVersion: number; period: number; date: string; payers: Share[]; description?: string; category?: string; notes?: string }
);
export interface ResolvedExpense { totalMinor: number; payers: Share[]; shares: Share[]; itemized?: ItemizedResult }
export type LedgerEntryKind = FinancialInput["kind"];
export type LedgerOrigin = "app" | "api" | "mcp";
export type LedgerLifecycle = "effective" | "void";
export interface LedgerRevision {
  entryId: string; version: number; actorId: string; origin: LedgerOrigin; operationId: string;
  action: "create" | "correct" | "void" | "restore" | "post"; acceptedAt: string;
}
export interface LedgerComment { id: string; entryId: string; authorId: string; text: string; acceptedAt: string }
export interface RecurringPostingSource {
  ruleId: string; ruleVersion: number; period: number;
  periodStart: string; periodEnd: string;
  snapshot: {
    name: string; currency: Currency; totalMinor: number;
    cadence: { unit: "day" | "week" | "month" | "year"; interval: number; anchorDate: string };
    shares: Share[];
  };
}
export interface LedgerEntry {
  id: string; householdId: string; version: number; lifecycle: LedgerLifecycle;
  intent: FinancialInput; payers: Share[]; shares: Share[];
  itemized?: ItemizedResult;
  source?: RecurringPostingSource; createdAt: string; updatedAt: string;
}
/** Signed effects are authoritative-accounting proposals, never a second direct-debt store. */
export interface LedgerEffect { entryId: string; version: number; memberId: string; currency: Currency; amountMinor: number }
export interface LedgerPage<T> { items: T[]; nextCursor: string | null; revision: number }

/** Immutable accepted raw + resolved snapshot; transitions never replace current effects. */
export interface StoredLedgerRevision extends LedgerRevision {
  snapshot: LedgerEntry;
  transitions: Array<LedgerEffect & { effectKind: "reversal" | "replacement" }>;
}
