import type { HouseholdCommand } from "../../platform/household-command";
import type { AuditChange } from "../../inventory/repository";
import type { CommandContext } from "../../platform/context";
import type { ExpenseFilter, StoredExpenseRule } from "./model";

export interface ExpenseMutation {
  command?: HouseholdCommand;
  context: CommandContext;
  action: string;
  expectedVersion: number;
  changes: AuditChange[];
}

export interface ExpenseRepository {
  beginMutation?(context: CommandContext, action: string, entityId: string | undefined, input: unknown): Promise<{ command: HouseholdCommand; replay: StoredExpenseRule | null }>;
  listRules(householdId: string, filter: ExpenseFilter): Promise<StoredExpenseRule[]>;
  getRule(householdId: string, ruleId: string): Promise<StoredExpenseRule>;
  createRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  updateRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  setArchived(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule>;
  listMembers(householdId: string): Promise<Array<{ id: string; active: boolean }>>;
}
