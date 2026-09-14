import type { SplitOverride } from "../shares/resolver";

export type CadenceUnit = "day" | "week" | "month" | "year";
export type ArchivedFilter = "exclude" | "only" | "include";

export interface Cadence {
  unit: CadenceUnit;
  interval: number;
  anchorDate: string;
}

export interface StoredExpenseParticipant {
  memberId: string;
  override: SplitOverride | null;
}

/** A rule exactly as it is persisted: everything the household stated, nothing derived. */
export interface StoredExpenseRule {
  id: string;
  householdId: string;
  name: string;
  amountMinor: number;
  currency: string;
  cadence: Cadence;
  participants: StoredExpenseParticipant[];
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseParticipant extends StoredExpenseParticipant {
  shareMinor: number;
  memberActive: boolean;
}

export interface ExpenseRule extends StoredExpenseRule {
  participants: ExpenseParticipant[];
  needsAttention: boolean;
}

export interface ExpenseParticipantInput {
  memberId: string;
  override?: SplitOverride | null;
}

export interface CreateExpenseInput {
  id?: string;
  name: string;
  amountMinor: number;
  currency?: string;
  cadence: Cadence;
  participants: ExpenseParticipantInput[];
}

export interface UpdateExpenseInput {
  name?: string;
  amountMinor?: number;
  currency?: string;
  cadence?: Cadence;
  participants?: ExpenseParticipantInput[];
}

export interface ExpenseFilter {
  archived?: ArchivedFilter;
}

export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
};

export const DEFAULT_CURRENCY = "INR";
