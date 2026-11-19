import type { Action } from '../auth/permissions';
import type { CommandContext } from '../platform/context';
import type { HouseholdCommand } from '../platform/household-command';
import type { LedgerComment, LedgerEffect, LedgerEntry, RecurringPostingSource, StoredLedgerRevision } from './model';
export interface LedgerAcceptance {
    command: HouseholdCommand;
    before: LedgerEntry | null;
    after: LedgerEntry;
    revision: StoredLedgerRevision;
}
/** Internal persistence API. Caller must hold exact authority for every disclosure. */
export interface LedgerRepository {
    begin(context: CommandContext, action: string, entryId: string | undefined, input: unknown): Promise<{
        command: HouseholdCommand;
        replay: LedgerEntry | null;
    }>;
    beginComment(context: CommandContext, entryId: string, text: string): Promise<{ command: HouseholdCommand; replay: LedgerComment | null }>;
    acceptComment(command: HouseholdCommand, comment: LedgerComment, expectedVersion: number): Promise<LedgerComment>;
    postingBasis(householdId: string, ruleId: string, expectedVersion: number, period: number): Promise<RecurringPostingSource>;
    authorize(context: CommandContext, action: Action): Promise<void>;
    getEntry(householdId: string, entryId: string): Promise<LedgerEntry>;
    accept(proposal: LedgerAcceptance): Promise<LedgerEntry>;
    /** Internal accounting proof helper; public aggregates are U4's scoped queries. */
    currentEffects(householdId: string): Promise<LedgerEffect[]>;
    /** Internal retained-history proof helper; never expose as a public unpaged read. */
    history(householdId: string, entryId: string): Promise<StoredLedgerRevision[]>;
}
