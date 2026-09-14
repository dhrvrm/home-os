import { ConflictError, NotFoundError } from "../../platform/errors";
import { createId } from "../../platform/ids";
import type { CadenceUnit, ExpenseFilter, StoredExpenseParticipant, StoredExpenseRule } from "./model";
import type { ExpenseMutation, ExpenseRepository } from "./repository";

interface RuleRow {
  id: string;
  household_id: string;
  name: string;
  amount_minor: number;
  currency: string;
  cadence_unit: CadenceUnit;
  cadence_interval: number;
  anchor_date: string;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ParticipantRow {
  rule_id: string;
  member_id: string;
  override_kind: "fixed" | "percent" | null;
  override_value: number | null;
}

interface MemberRow {
  id: string;
  archived_at: string | null;
}

interface ProcessedRow {
  result_json: string;
}

const RULE_COLUMNS = `id, household_id, name, amount_minor, currency, cadence_unit,
                      cadence_interval, anchor_date, version, created_at, updated_at, archived_at`;

export class D1ExpenseRepository implements ExpenseRepository {
  constructor(private readonly database: D1Database) {}

  async listRules(householdId: string, filter: ExpenseFilter): Promise<StoredExpenseRule[]> {
    const result = await this.database
      .prepare(
        `SELECT ${RULE_COLUMNS}
           FROM expense_rules
          WHERE household_id = ?
          ORDER BY updated_at DESC, id ASC`,
      )
      .bind(householdId)
      .all<RuleRow>();
    const rows = result.results.filter((row) => {
      if (filter.archived === "only") return row.archived_at !== null;
      if (filter.archived === "include") return true;
      return row.archived_at === null;
    });
    if (rows.length === 0) return [];

    const participants = await this.participantsFor(rows.map((row) => row.id));
    return rows.map((row) => mapRule(row, participants.get(row.id) ?? []));
  }

  async getRule(householdId: string, ruleId: string): Promise<StoredExpenseRule> {
    const row = await this.database
      .prepare(`SELECT ${RULE_COLUMNS} FROM expense_rules WHERE household_id = ? AND id = ?`)
      .bind(householdId, ruleId)
      .first<RuleRow>();
    if (!row) throw new NotFoundError("expense_rule", ruleId);
    const participants = await this.participantsFor([row.id]);
    return mapRule(row, participants.get(row.id) ?? []);
  }

  async listMembers(householdId: string): Promise<Array<{ id: string; active: boolean }>> {
    const result = await this.database
      .prepare("SELECT id, archived_at FROM members WHERE household_id = ? ORDER BY id ASC")
      .bind(householdId)
      .all<MemberRow>();
    return result.results.map((row) => ({ id: row.id, active: row.archived_at === null }));
  }

  async createRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule> {
    const replay = await this.replayedRule(mutation);
    if (replay) return replay;
    return this.executeMutation(
      [
        this.database
          .prepare(
            `INSERT INTO expense_rules (
               id, household_id, name, amount_minor, currency, cadence_unit,
               cadence_interval, anchor_date, version, created_at, updated_at, archived_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            rule.id,
            rule.householdId,
            rule.name,
            rule.amountMinor,
            rule.currency,
            rule.cadence.unit,
            rule.cadence.interval,
            rule.cadence.anchorDate,
            rule.version,
            rule.createdAt,
            rule.updatedAt,
            rule.archivedAt,
          ),
        ...this.participantStatements(rule, false),
        this.processedStatement(rule, mutation),
        this.auditStatement(rule, mutation),
      ],
      rule,
      mutation,
    );
  }

  async updateRule(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule> {
    const replay = await this.replayedRule(mutation);
    if (replay) return replay;
    return this.executeMutation(
      [
        this.guardStatement(rule, mutation),
        this.database
          .prepare(
            `UPDATE expense_rules
                SET name = ?, amount_minor = ?, currency = ?, cadence_unit = ?,
                    cadence_interval = ?, anchor_date = ?, version = ?, updated_at = ?
              WHERE household_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            rule.name,
            rule.amountMinor,
            rule.currency,
            rule.cadence.unit,
            rule.cadence.interval,
            rule.cadence.anchorDate,
            rule.version,
            rule.updatedAt,
            rule.householdId,
            rule.id,
            mutation.expectedVersion,
          ),
        ...this.participantStatements(rule, true),
        this.processedStatement(rule, mutation),
        this.auditStatement(rule, mutation),
        this.releaseGuardStatement(rule, mutation),
      ],
      rule,
      mutation,
    );
  }

  async setArchived(rule: StoredExpenseRule, mutation: ExpenseMutation): Promise<StoredExpenseRule> {
    const replay = await this.replayedRule(mutation);
    if (replay) return replay;
    return this.executeMutation(
      [
        this.guardStatement(rule, mutation),
        this.database
          .prepare(
            `UPDATE expense_rules
                SET archived_at = ?, version = ?, updated_at = ?
              WHERE household_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            rule.archivedAt,
            rule.version,
            rule.updatedAt,
            rule.householdId,
            rule.id,
            mutation.expectedVersion,
          ),
        this.processedStatement(rule, mutation),
        this.auditStatement(rule, mutation),
        this.releaseGuardStatement(rule, mutation),
      ],
      rule,
      mutation,
    );
  }

  private async participantsFor(ruleIds: string[]): Promise<Map<string, StoredExpenseParticipant[]>> {
    const placeholders = ruleIds.map(() => "?").join(", ");
    const result = await this.database
      .prepare(
        `SELECT rule_id, member_id, override_kind, override_value
           FROM expense_participants
          WHERE rule_id IN (${placeholders})
          ORDER BY rule_id ASC, position ASC`,
      )
      .bind(...ruleIds)
      .all<ParticipantRow>();

    const participants = new Map<string, StoredExpenseParticipant[]>();
    for (const row of result.results) {
      const entries = participants.get(row.rule_id) ?? [];
      entries.push({ memberId: row.member_id, override: mapOverride(row) });
      participants.set(row.rule_id, entries);
    }
    return participants;
  }

  private participantStatements(rule: StoredExpenseRule, replace: boolean): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [];
    if (replace) {
      statements.push(
        this.database.prepare("DELETE FROM expense_participants WHERE rule_id = ?").bind(rule.id),
      );
    }
    rule.participants.forEach((participant, position) => {
      statements.push(
        this.database
          .prepare(
            `INSERT INTO expense_participants (rule_id, member_id, position, override_kind, override_value)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            rule.id,
            participant.memberId,
            position,
            participant.override?.kind ?? null,
            overrideValue(participant),
          ),
      );
    });
    return statements;
  }

  private guardStatement(rule: StoredExpenseRule, mutation: ExpenseMutation): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO mutation_guards (
           household_id, operation_id, expected_version, actual_version
         ) VALUES (
           ?, ?, ?, COALESCE((SELECT version FROM expense_rules WHERE household_id = ? AND id = ?), -1)
         )`,
      )
      .bind(
        rule.householdId,
        mutation.context.operationId,
        mutation.expectedVersion,
        rule.householdId,
        rule.id,
      );
  }

  private releaseGuardStatement(rule: StoredExpenseRule, mutation: ExpenseMutation): D1PreparedStatement {
    return this.database
      .prepare("DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?")
      .bind(rule.householdId, mutation.context.operationId);
  }

  private processedStatement(rule: StoredExpenseRule, mutation: ExpenseMutation): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO processed_operations (
           household_id, operation_id, entity_type, entity_id, result_json, processed_at
         ) VALUES (?, ?, 'expense_rule', ?, ?, ?)`,
      )
      .bind(
        rule.householdId,
        mutation.context.operationId,
        rule.id,
        JSON.stringify(rule),
        rule.updatedAt,
      );
  }

  private auditStatement(rule: StoredExpenseRule, mutation: ExpenseMutation): D1PreparedStatement {
    const context = mutation.context;
    return this.database
      .prepare(
        `INSERT INTO audit_events (
           id, household_id, entity_type, entity_id, action, actor_id, actor_type,
           source, device_id, operation_id, client_time, server_time, changes_json,
           mcp_client_id, mcp_tool
         ) VALUES (?, ?, 'expense_rule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        createId(),
        rule.householdId,
        rule.id,
        mutation.action,
        context.actorId,
        context.actorType,
        context.source,
        context.deviceId ?? null,
        context.operationId,
        context.clientTime ?? null,
        rule.updatedAt,
        JSON.stringify(mutation.changes),
        context.mcpClientId ?? null,
        context.mcpTool ?? null,
      );
  }

  private async replayedRule(mutation: ExpenseMutation): Promise<StoredExpenseRule | null> {
    const row = await this.database
      .prepare("SELECT result_json FROM processed_operations WHERE household_id = ? AND operation_id = ?")
      .bind(mutation.context.householdId, mutation.context.operationId)
      .first<ProcessedRow>();
    return row ? (JSON.parse(row.result_json) as StoredExpenseRule) : null;
  }

  private async executeMutation(
    statements: D1PreparedStatement[],
    rule: StoredExpenseRule,
    mutation: ExpenseMutation,
  ): Promise<StoredExpenseRule> {
    try {
      await this.database.batch(statements);
      return structuredClone(rule);
    } catch (error) {
      const replay = await this.replayedRule(mutation);
      if (replay) return replay;
      const current = await this.database
        .prepare("SELECT version FROM expense_rules WHERE household_id = ? AND id = ?")
        .bind(rule.householdId, rule.id)
        .first<{ version: number }>();
      if (mutation.expectedVersion > 0) {
        if (!current) throw new NotFoundError("expense_rule", rule.id);
        if (current.version !== mutation.expectedVersion) {
          throw new ConflictError("expense_rule", rule.id, mutation.expectedVersion, current.version);
        }
      }
      throw error;
    }
  }
}

function mapRule(row: RuleRow, participants: StoredExpenseParticipant[]): StoredExpenseRule {
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    cadence: {
      unit: row.cadence_unit,
      interval: row.cadence_interval,
      anchorDate: row.anchor_date,
    },
    participants,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOverride(row: ParticipantRow): StoredExpenseParticipant["override"] {
  if (row.override_kind === "fixed") return { kind: "fixed", amountMinor: row.override_value! };
  if (row.override_kind === "percent") return { kind: "percent", basisPoints: row.override_value! };
  return null;
}

function overrideValue(participant: StoredExpenseParticipant): number | null {
  if (!participant.override) return null;
  return participant.override.kind === "fixed"
    ? participant.override.amountMinor
    : participant.override.basisPoints;
}
