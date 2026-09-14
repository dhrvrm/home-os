"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowClockwise, Plus, Receipt, WarningCircle } from "@phosphor-icons/react";
import { APIError, archiveExpense, createExpense, listExpenses, listMembers, restoreExpense, updateExpense } from "@/lib/api";
import { describeCadence, formatMinorAmount, type CreateExpenseInput, type ExpenseRule, type Member } from "@/lib/expenses";
import { ExpenseRuleDialog } from "./expense-rule-dialog";

type LoadState = "loading" | "error" | "ready";
type DialogState = { mode: "create" } | { mode: "edit"; rule: ExpenseRule; expectedVersion: number };

export function ExpensesView() {
  const [rules, setRules] = useState<ExpenseRule[]>([]);
  const [archivedRules, setArchivedRules] = useState<ExpenseRule[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingRule, setPendingRule] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<ExpenseRule[]> => {
    const [active, archived, household] = await Promise.all([
      listExpenses(),
      listExpenses({ archived: "only" }),
      listMembers(),
    ]);
    setRules(active);
    setArchivedRules(archived);
    setMembers(household);
    return active;
  }, []);

  const load = useCallback(async () => {
    try {
      await refresh();
      setLoadState("ready");
    } catch (error) {
      setLoadError(message(error, "Expenses could not be loaded."));
      setLoadState("error");
    }
  }, [refresh]);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  async function saveRule(input: CreateExpenseInput) {
    setSaving(true);
    setMutationError(null);
    try {
      if (dialog?.mode === "edit") {
        await updateExpense(dialog.rule.id, input, { operationId: crypto.randomUUID(), expectedVersion: dialog.expectedVersion });
      } else {
        await createExpense(input, { operationId: crypto.randomUUID() });
      }
      await refresh();
      setDialog(null);
    } catch (error) {
      setMutationError(message(error, "The expense could not be saved."));
      if (error instanceof APIError && error.code === "conflict") await rebase();
    } finally {
      setSaving(false);
    }
  }

  /** Keeps the user's entries and moves the guard forward, so a resubmit lands on the latest rule. */
  async function rebase() {
    try {
      const active = await refresh();
      setDialog((current) => {
        if (current?.mode !== "edit") return current;
        const latest = active.find((rule) => rule.id === current.rule.id);
        return latest ? { ...current, expectedVersion: latest.version } : current;
      });
    } catch {
      // The conflict message already stands; a failed refresh must not replace it.
    }
  }

  async function archiveRule(rule: ExpenseRule) {
    if (!window.confirm(`Archive ${rule.name}? Its history will be kept.`)) return;
    await mutate(rule, () => archiveExpense(rule.id, { operationId: crypto.randomUUID(), expectedVersion: rule.version }), "The expense could not be archived.");
  }

  async function restoreRule(rule: ExpenseRule) {
    await mutate(rule, () => restoreExpense(rule.id, { operationId: crypto.randomUUID(), expectedVersion: rule.version }), "The expense could not be restored.");
  }

  async function mutate(rule: ExpenseRule, action: () => Promise<ExpenseRule>, fallback: string) {
    setPendingRule(rule.id);
    setMutationError(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setMutationError(message(error, fallback));
    } finally {
      setPendingRule(null);
    }
  }

  const listed = showArchived ? archivedRules : rules;

  return (
    <section className="expenses-panel" aria-labelledby="expenses-title">
      <header className="expenses-panel__header">
        <div>
          <h2 id="expenses-title">{showArchived ? "Archived expenses" : "Recurring expenses"}</h2>
          <p>{showArchived ? `${archivedRules.length} archived` : `${rules.length} recurring`}</p>
        </div>
        <div className="expenses-panel__tools">
          <button className="button button--small button--quiet" type="button" onClick={() => setShowArchived((current) => !current)}>
            <Archive size={16} aria-hidden="true" /> {showArchived ? "Active" : "Archived"}
          </button>
          {!showArchived && <button className="button button--primary" type="button" onClick={() => setDialog({ mode: "create" })}>
            <Plus size={18} weight="bold" aria-hidden="true" /> Add expense
          </button>}
        </div>
      </header>

      {mutationError && (
        <div className="inline-error" role="alert"><WarningCircle size={19} weight="fill" aria-hidden="true" /><span>{mutationError}</span><button type="button" onClick={() => setMutationError(null)}>Dismiss</button></div>
      )}

      {loadState === "loading" && <div className="loading-state" aria-live="polite"><p>Loading recurring expenses</p></div>}
      {loadState === "error" && (
        <div className="error-state" role="alert">
          <WarningCircle size={30} weight="duotone" aria-hidden="true" />
          <h2>Expenses could not be loaded</h2>
          <p>{loadError}</p>
          <button className="button button--quiet" type="button" onClick={() => { setLoadState("loading"); setLoadError(null); void load(); }}><ArrowClockwise size={17} weight="bold" aria-hidden="true" /> Try again</button>
        </div>
      )}

      {loadState === "ready" && listed.length === 0 && (
        <div className="no-results">
          <Receipt size={26} aria-hidden="true" />
          <h3>{showArchived ? "No archived expenses" : "No recurring expenses yet"}</h3>
          <p>{showArchived ? "Expenses you archive stay recoverable here." : "Add rent, utilities, or any shared cost that repeats."}</p>
          {!showArchived && <button className="button button--primary" type="button" onClick={() => setDialog({ mode: "create" })}>Add your first expense</button>}
        </div>
      )}

      {loadState === "ready" && listed.length > 0 && (
        <div className={showArchived ? "archived-list" : "expense-list"}>
          {listed.map((rule) => (
            <article key={rule.id} aria-label={rule.name}>
              <div>
                <h3>{rule.name}</h3>
                <p>{formatMinorAmount(rule.amountMinor, rule.currency)} · {describeCadence(rule.cadence)}</p>
                {!showArchived && <ul className="expense-shares">
                  {rule.participants.map((participant) => (
                    <li key={participant.memberId}>{memberName(members, participant.memberId)} · {formatMinorAmount(participant.shareMinor, rule.currency)}</li>
                  ))}
                </ul>}
                {rule.needsAttention && <p className="expense-attention">
                  <WarningCircle size={16} weight="fill" aria-hidden="true" /> {inactiveNames(rule, members)} no longer in the household.
                </p>}
              </div>
              <div className="expense-actions">
                {showArchived
                  ? <button className="button button--small button--quiet" type="button" disabled={pendingRule === rule.id} onClick={() => void restoreRule(rule)} aria-label={`Restore ${rule.name}`}>Restore</button>
                  : <>
                      <button className="button button--small button--quiet" type="button" onClick={() => setDialog({ mode: "edit", rule, expectedVersion: rule.version })} aria-label={`Edit ${rule.name}`}>Edit</button>
                      <button className="button button--small button--quiet" type="button" disabled={pendingRule === rule.id} onClick={() => void archiveRule(rule)} aria-label={`Archive ${rule.name}`}>Archive</button>
                    </>}
              </div>
            </article>
          ))}
        </div>
      )}

      {dialog && <ExpenseRuleDialog
        rule={dialog.mode === "edit" ? dialog.rule : undefined}
        members={members}
        pending={saving}
        error={mutationError}
        onClose={() => { setDialog(null); setMutationError(null); }}
        onSubmit={saveRule}
      />}
    </section>
  );
}

function inactiveNames(rule: ExpenseRule, members: Member[]): string {
  const names = rule.participants.filter((participant) => !participant.memberActive).map((participant) => memberName(members, participant.memberId));
  return names.length === 1 ? `${names[0]} is` : `${names.join(", ")} are`;
}

function memberName(members: Member[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
