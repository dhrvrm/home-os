import type { AuditChange } from "../../inventory/repository";
import type { CommandContext } from "../../platform/context";
import type { ExpenseFilter, StoredExpenseRule } from "./model";

export interface ExpenseMutation {
  context: CommandContext;
  action: string;
  expectedVersion: number;
  changes: AuditChange[];
}

export interface ExpenseRepository {
  listRules(householdId: string, filter: ExpenseFilter): Promise<StoredExpenseRule[]>;
  getRule(householdId: string, ruleId: string): Promise<StoredExpenseRule>;
  createRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  updateRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  setArchived(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  listMembers(householdId: string): Promise<Array<{ id: string; active: boolean }>>;
}
