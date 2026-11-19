"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArrowClockwise, Plus, Receipt, WarningCircle } from "@phosphor-icons/react";
import { APIError, archiveExpense, createExpense, listExpenses, listMembers, restoreExpense, updateExpense } from "@/lib/api";
import { describeCadence, formatMinorAmount, type CreateExpenseInput, type ExpenseRule, type Member } from "@/lib/expenses";
import type { AuthUser } from "@/lib/auth";
import { runHouseholdWork } from "@/auth/work";
import { requireIdentity } from "@/household/api";
import { useOnline } from "@/household/ui";
import { ExpenseRuleDialog } from "./expense-rule-dialog";

type LoadState = "loading" | "error" | "ready";
type DialogState = { mode: "create" } | { mode: "edit"; rule: ExpenseRule; expectedVersion: number };

export function ExpensesView({ readOnly = false, user, onPost, onDirtyChange }: { readOnly?: boolean; user?: AuthUser; onPost?: (rule: ExpenseRule) => void; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const connected = useOnline();
  const attempts = useRef(new Map<string,string>());
  const [conflicting, setConflicting] = useState(false);
  const scoped = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => runHouseholdWork(async lease => { if(user) requireIdentity(user,lease); const value = await action(); if(user) requireIdentity(user,lease); return value; }),[user]);
  function operation(intent: unknown): string { const key=JSON.stringify(intent); const existing=attempts.current.get(key); if(existing)return existing; const id=crypto.randomUUID();attempts.current.set(key,id);return id; }
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
    const [active, archived, household] = await scoped(() => Promise.all([
      listExpenses(),
      listExpenses({ archived: "only" }),
      listMembers(),
    ]));
    setRules(active);
    setArchivedRules(archived);
    setMembers(household);
    return active;
  }, [scoped]);

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

  useEffect(() => { onDirtyChange?.(!!dialog || saving); return () => onDirtyChange?.(false); }, [dialog, saving, onDirtyChange]);

  async function saveRule(input: CreateExpenseInput) {
    if (readOnly || !connected || conflicting) return;
    setSaving(true);
    setMutationError(null);
    try {
      if (dialog?.mode === "edit") {
        await scoped(() => updateExpense(dialog.rule.id, input, { operationId: operation(["update",dialog.rule.id,dialog.expectedVersion,input]), expectedVersion: dialog.expectedVersion }));
      } else {
        await scoped(() => createExpense(input, { operationId: operation(["create",input]) }));
      }
      setDialog(null);
      attempts.current.clear();
      try { await refresh(); } catch { setMutationError("Rule saved. Refresh the recurring rules to inspect the latest list."); }
    } catch (error) {
      setMutationError(message(error, "The expense could not be saved."));
      if (error instanceof APIError && error.code === "conflict") setConflicting(true);
    } finally {
      setSaving(false);
    }
  }

  /** Explicit review only: a conflict never changes the observed version automatically. */
  async function rebase() {
    try {
      const active = await refresh();
      setDialog((current) => {
        if (current?.mode !== "edit") return current;
        const latest = active.find((rule) => rule.id === current.rule.id);
        return latest ? { ...current, expectedVersion: latest.version } : current;
      });
      setConflicting(false);
    } catch {
      // The conflict message already stands; a failed refresh must not replace it.
    }
  }

  async function archiveRule(rule: ExpenseRule) {
    if (!window.confirm(`Archive ${rule.name}? Its history will be kept.`)) return;
    await mutate(rule, () => archiveExpense(rule.id, { operationId: operation(["archive",rule.id,rule.version]), expectedVersion: rule.version }), "The expense could not be archived.");
  }

  async function restoreRule(rule: ExpenseRule) {
    await mutate(rule, () => restoreExpense(rule.id, { operationId: operation(["restore",rule.id,rule.version]), expectedVersion: rule.version }), "The expense could not be restored.");
  }

  async function mutate(rule: ExpenseRule, action: () => Promise<ExpenseRule>, fallback: string) {
    if (readOnly || !connected) return;
    setPendingRule(rule.id);
    setMutationError(null);
    try {
      await scoped(action);
      attempts.current.clear();
      try { await refresh(); } catch { setMutationError("Rule updated. Refresh to inspect the latest list."); }
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
          <h2 id="expenses-title">{showArchived ? "Archived recurring rules" : "Recurring rules"}</h2>
          <p>{showArchived ? `${archivedRules.length} archived` : `${rules.length} recurring`} · Templates only; rules do not count as recorded expenses or balances.</p>
        </div>
        <div className="expenses-panel__tools">
          <button className="button button--small button--quiet" type="button" onClick={() => setShowArchived((current) => !current)}>
            <Archive size={16} aria-hidden="true" /> {showArchived ? "Active" : "Archived"}
          </button>
          {!showArchived && !readOnly && <button className="button button--primary" type="button" onClick={() => setDialog({ mode: "create" })}>
            <Plus size={18} weight="bold" aria-hidden="true" /> Add recurring rule
          </button>}
        </div>
      </header>

      {!connected && <p role="status">Connect to maintain recurring rules or record a period.</p>}
      {conflicting && <p role="alert">Review the latest rule before another save. Your entered draft is retained. <button type="button" className="button button--quiet" onClick={() => void rebase()}>Review latest rule</button></p>}
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
          <h3>{showArchived ? "No archived recurring rules" : "No recurring rules yet"}</h3>
          <p>{showArchived ? "Expenses you archive stay recoverable here." : "Add rent, utilities, or any shared cost that repeats."}</p>
          {!showArchived && !readOnly && <button className="button button--primary" type="button" onClick={() => setDialog({ mode: "create" })}>Add your first recurring rule</button>}
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
              {!readOnly && <div className="expense-actions">
                {showArchived
                  ? <button className="button button--small button--quiet" type="button" disabled={!connected || pendingRule === rule.id} onClick={() => void restoreRule(rule)} aria-label={`Restore ${rule.name}`}>Restore</button>
                  : <>
                      <button className="button button--small button--quiet" type="button" disabled={!connected} onClick={() => {setConflicting(false);setDialog({ mode: "edit", rule, expectedVersion: rule.version });}} aria-label={`Edit ${rule.name}`}>Edit</button>
                      {onPost && <button className="button button--small button--quiet" type="button" disabled={!connected || rule.needsAttention} onClick={() => onPost(rule)}>Record period for {rule.name}</button>}
                      <button className="button button--small button--quiet" type="button" disabled={!connected || pendingRule === rule.id} onClick={() => void archiveRule(rule)} aria-label={`Archive ${rule.name}`}>Archive</button>
                    </>}
              </div>}
            </article>
          ))}
        </div>
      )}

      {dialog && !readOnly && <ExpenseRuleDialog
        rule={dialog.mode === "edit" ? dialog.rule : undefined}
        members={members}
        pending={saving}
        error={mutationError}
        onClose={() => { if (!window.confirm("Discard this unsaved recurring rule draft?")) return; setDialog(null); setMutationError(null); setConflicting(false); }}
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
