import type { Currency, RecurringPostingSource } from "../../ledger/model";
import type { HouseholdCommand } from "../../platform/household-command";
import type { CommandContext } from "../../platform/context";
import { ConflictError, ValidationError } from "../../platform/errors";
import { createId } from "../../platform/ids";
import type { AuditChange } from "../../inventory/repository";
import { resolveShares, type SplitRequest } from "../shares/resolver";
import {
  CURRENCY_MINOR_UNITS,
  DEFAULT_CURRENCY,
  type CreateExpenseInput,
  type ExpenseFilter,
  type ExpenseParticipantInput,
  type ExpenseRule,
  type StoredExpenseParticipant,
  type StoredExpenseRule,
  type UpdateExpenseInput,
} from "./model";
import type { ExpenseMutation, ExpenseRepository } from "./repository";
import { MAX_PARTICIPANTS, assertAmountMinor, assertCadence, assertName } from "./validation";

const ACTION_CREATED = "expenses.rule.created";
const ACTION_UPDATED = "expenses.rule.updated";
const ACTION_ARCHIVED = "expenses.rule.archived";
const ACTION_RESTORED = "expenses.rule.restored";

const AUDITED_FIELDS: Array<keyof StoredExpenseRule> = [
  "name",
  "amountMinor",
  "currency",
  "cadence",
  "participants",
  "archivedAt",
];

type MemberIndex = Map<string, boolean>;

interface ExpenseServiceOptions {
  now?: () => Date;
  newId?: () => string;
}

export class ExpenseService {
  /** Internal posting basis; ledger admission and atomic acceptance guard disclosure/writes. */
  async postingBasis(householdId: string, ruleId: string, expectedVersion: number, period: number): Promise<RecurringPostingSource> {
    const rule = await this.repository.getRule(householdId, ruleId);
    if (rule.version !== expectedVersion) throw new ConflictError('expense_rule', ruleId, expectedVersion, rule.version, rule);
    if (rule.archivedAt !== null) throw new ValidationError('ruleId', 'Archived rules cannot be posted');
    const members = await this.memberIndex(householdId, rule.participants.map(p => p.memberId));
    if (rule.participants.some(p => members.get(p.memberId) !== true)) throw new ValidationError('participants', 'Review departed rule participants before posting');
    const resolved = resolveShares(splitRequest(rule));
    if (!resolved.ok) throw new ValidationError('participants', 'The current rule shares cannot be resolved');
    return { ruleId: rule.id, ruleVersion: rule.version, period,
      periodStart: cadenceBoundary(rule.cadence, period), periodEnd: cadenceBoundary(rule.cadence, BigInt(period) + BigInt(1)),
      snapshot: { name: rule.name, currency: rule.currency as Currency, totalMinor: rule.amountMinor, cadence: { ...rule.cadence }, shares: resolved.shares.map(p => ({ memberId: p.memberId, amountMinor: p.amountMinor })) } };
  }

  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly repository: ExpenseRepository,
    options: ExpenseServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? createId;
  }

  async listRules(householdId: string, filter: ExpenseFilter = {}): Promise<ExpenseRule[]> {
    const rules = await this.repository.listRules(householdId, {
      archived: filter.archived ?? "exclude",
    });
    const members = await this.memberIndex(householdId);
    return rules.map((rule) => enrich(rule, members));
  }

  async listRulesPage(householdId: string, filter: ExpenseFilter, page: import("../../inventory/validation").PageInput = {}) {
    if (!this.repository.listRulesPage) throw new Error("Paged expenses require a bounded repository");
    const result = await this.repository.listRulesPage(householdId, filter, page);
    const members = await this.memberIndex(householdId);
    return { rules: result.items.map(rule => enrich(rule, members)), nextCursor: result.nextCursor };
  }

  async getRule(householdId: string, ruleId: string): Promise<ExpenseRule> {
    const rule = await this.repository.getRule(householdId, ruleId.trim());
    return enrich(rule, await this.memberIndex(householdId));
  }

  async createRule(context: CommandContext, input: CreateExpenseInput): Promise<ExpenseRule> {
    const admission = await this.repository.beginMutation?.(context, ACTION_CREATED, undefined, input);
    if (admission?.replay) return enrich(admission.replay, await this.memberIndex(context.householdId));
    const members = await this.memberIndex(context.householdId);
    const currency = assertCurrency(input.currency ?? DEFAULT_CURRENCY);
    const timestamp = this.now().toISOString();
    const rule: StoredExpenseRule = {
      id: input.id ?? this.newId(),
      householdId: context.householdId,
      name: assertName(input.name),
      amountMinor: assertAmountMinor(input.amountMinor),
      currency,
      cadence: assertCadence(input.cadence),
      participants: assertParticipants(input.participants, members, new Set()),
      version: 1,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertResolvable(rule);

    const stored = await this.repository.createRule(rule, {
      context,
      command: admission?.command,
      action: ACTION_CREATED,
      expectedVersion: 0,
      changes: createdFields(rule),
    });
    return enrich(stored, members);
  }

  async updateRule(
    context: CommandContext,
    ruleId: string,
    input: UpdateExpenseInput,
  ): Promise<ExpenseRule> {
    const admission = await this.repository.beginMutation?.(context, ACTION_UPDATED, ruleId.trim(), input);
    if (admission?.replay) return enrich(admission.replay, await this.memberIndex(context.householdId));
    const current = await this.repository.getRule(context.householdId, ruleId.trim());
    const members = await this.memberIndex(context.householdId);
    const next = structuredClone(current);

    if (input.name !== undefined) next.name = assertName(input.name);
    if (input.amountMinor !== undefined) next.amountMinor = assertAmountMinor(input.amountMinor);
    if (input.currency !== undefined) next.currency = assertCurrency(input.currency);
    if (input.cadence !== undefined) next.cadence = assertCadence(input.cadence);
    if (input.participants !== undefined) {
      const retained = new Set(current.participants.map((participant) => participant.memberId));
      next.participants = assertParticipants(input.participants, members, retained);
    }
    assertResolvable(next);

    next.updatedAt = this.now().toISOString();
    next.version = current.version + 1;
    const updated = await this.applied(context, current, () =>
      this.repository.updateRule(
        next,
        this.mutation(context, ACTION_UPDATED, current.version, changedFields(current, next), admission?.command),
      ),
    );
    return enrich(updated, members);
  }

  async archiveRule(context: CommandContext, ruleId: string): Promise<ExpenseRule> {
    return this.setArchived(context, ruleId, true);
  }

  async restoreRule(context: CommandContext, ruleId: string): Promise<ExpenseRule> {
    return this.setArchived(context, ruleId, false);
  }

  private async setArchived(
    context: CommandContext,
    ruleId: string,
    archived: boolean,
  ): Promise<ExpenseRule> {
    const admission = await this.repository.beginMutation?.(context, archived ? ACTION_ARCHIVED : ACTION_RESTORED, ruleId.trim(), {});
    if (admission?.replay) return enrich(admission.replay, await this.memberIndex(context.householdId));
    const current = await this.repository.getRule(context.householdId, ruleId.trim());
    const members = await this.memberIndex(context.householdId);
    if ((current.archivedAt !== null) === archived) {
      if (!admission) return enrich(current, members);
      return enrich(await this.repository.setArchived(current, this.mutation(context, archived ? ACTION_ARCHIVED : ACTION_RESTORED, current.version, [], admission.command)), members);
    }

    const timestamp = this.now().toISOString();
    const next = structuredClone(current);
    next.archivedAt = archived ? timestamp : null;
    next.updatedAt = timestamp;
    next.version = current.version + 1;

    const updated = await this.applied(context, current, () =>
      this.repository.setArchived(
        next,
        this.mutation(
          context,
          archived ? ACTION_ARCHIVED : ACTION_RESTORED,
          current.version,
          changedFields(current, next),
          admission?.command,
        ),
      ),
    );
    return enrich(updated, members);
  }

  /**
   * A stale revision must come back with the rule as it now stands, not merely a version
   * number, so the caller can rebase without a second round trip.
   */
  private async applied(
    context: CommandContext,
    current: StoredExpenseRule,
    mutate: () => Promise<StoredExpenseRule>,
  ): Promise<StoredExpenseRule> {
    try {
      return await mutate();
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      throw new ConflictError(
        error.entityType,
        error.entityId,
        error.expectedVersion,
        error.actualVersion,
        await this.getRule(context.householdId, current.id),
      );
    }
  }

  private mutation(
    context: CommandContext,
    action: string,
    currentVersion: number,
    changes: AuditChange[],
    command?: HouseholdCommand,
  ): ExpenseMutation {
    return {
      context,
      action,
      command,
      expectedVersion: context.expectedVersion ?? currentVersion,
      changes,
    };
  }

  private async memberIndex(householdId: string, selectedIds?: readonly string[]): Promise<MemberIndex> {
    const members = await this.repository.listMembers(householdId, selectedIds);
    return new Map(members.map((member) => [member.id, member.active]));
  }
}

function assertCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!(currency in CURRENCY_MINOR_UNITS)) {
    throw new ValidationError("currency", "is not a currency this household records");
  }
  return currency;
}

function assertParticipants(
  inputs: ExpenseParticipantInput[],
  members: MemberIndex,
  retained: Set<string>,
): StoredExpenseParticipant[] {
  if (!inputs.length) throw new ValidationError("participants", "name at least one member");
  if (inputs.length > MAX_PARTICIPANTS) {
    throw new ValidationError("participants", `name no more than ${MAX_PARTICIPANTS} members`);
  }

  const seen = new Set<string>();
  return inputs.map((input) => {
    const memberId = input.memberId.trim();
    if (seen.has(memberId)) throw new ValidationError("participants", "name each member only once");
    seen.add(memberId);

    const active = members.get(memberId);
    if (active === undefined) {
      throw new ValidationError("participants", "name only members of this household");
    }
    if (!active && !retained.has(memberId)) {
      throw new ValidationError("participants", "cannot add a member who has left the household");
    }
    return { memberId, override: input.override ?? null };
  });
}

function splitRequest(rule: StoredExpenseRule): SplitRequest {
  return {
    totalMinor: rule.amountMinor,
    minorUnit: CURRENCY_MINOR_UNITS[rule.currency]!,
    participants: rule.participants.map((participant) => ({
      memberId: participant.memberId,
      override: participant.override ?? undefined,
    })),
  };
}

function assertResolvable(rule: StoredExpenseRule): void {
  const resolved = resolveShares(splitRequest(rule));
  if (!resolved.ok) {
    throw new ValidationError("participants", `split cannot be resolved: ${resolved.reason}`);
  }
}

function enrich(rule: StoredExpenseRule, members: MemberIndex): ExpenseRule {
  const resolved = resolveShares(splitRequest(rule));
  const participants = rule.participants.map((participant, index) => ({
    ...participant,
    // Writes reject unresolvable splits, so a read that cannot resolve means the stored rule
    // outlived its assumptions; surface it for attention rather than failing the whole read.
    shareMinor: resolved.ok ? resolved.shares[index]!.amountMinor : 0,
    memberActive: members.get(participant.memberId) ?? false,
  }));
  return {
    ...rule,
    participants,
    needsAttention: !resolved.ok || participants.some((participant) => !participant.memberActive),
  };
}

function changedFields(before: StoredExpenseRule, after: StoredExpenseRule): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of AUDITED_FIELDS) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    changes.push({ op: "replace", path: `/${field}`, oldValue: before[field], value: after[field] });
  }
  return changes;
}

function createdFields(rule: StoredExpenseRule): AuditChange[] {
  const fields: Array<keyof StoredExpenseRule> = [
    "name",
    "amountMinor",
    "currency",
    "cadence",
    "participants",
  ];
  return fields.map((field) => ({ op: "add", path: `/${field}`, value: rule[field] }));
}

/** Clamp each boundary directly from the anchor, never from an earlier clamp. */
function cadenceBoundary(cadence: StoredExpenseRule['cadence'], ordinal: number | bigint): string {
  if ((typeof ordinal === 'number' && !Number.isSafeInteger(ordinal)) || BigInt(ordinal) < BigInt(0)) throw new ValidationError('period', 'Choose a nonnegative safe ordinal');
  const steps = BigInt(ordinal) * BigInt(cadence.interval);
  const [year, month, day] = cadence.anchorDate.split('-').map(Number) as [number, number, number];
  let date: Date;
  if (cadence.unit === 'month' || cadence.unit === 'year') {
    const months = BigInt(year * 12 + month - 1) + steps * BigInt(cadence.unit === 'year' ? 12 : 1);
    if (months > BigInt(9999 * 12 + 11)) throw new ValidationError('period', 'Period exceeds the supported calendar');
    const y = Number(months / BigInt(12)), m = Number(months % BigInt(12));
    date = new Date(0); date.setUTCFullYear(y, m + 1, 0);
    const clamped = Math.min(day, date.getUTCDate()); date.setUTCFullYear(y, m, clamped);
  } else {
    const days = steps * BigInt(cadence.unit === 'week' ? 7 : 1);
    if (days > BigInt(3660000)) throw new ValidationError('period', 'Period exceeds the supported calendar');
    date = new Date(cadence.anchorDate + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + Number(days));
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new ValidationError('period', 'Period exceeds the supported calendar');
  return date.toISOString().slice(0,10);
}
