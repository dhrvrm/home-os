import type { CommandContext } from '../platform/context';
import { ConflictError, ValidationError } from '../platform/errors';
import { createId } from '../platform/ids';
import { effects, resolveExpense } from './allocation';
import type { ExpenseInput, FinancialInput, LedgerCommand, LedgerComment, LedgerEntry, LedgerRevision, PaymentInput, RecurringPostingSource, RefundInput } from './model';
import type { LedgerRepository } from './repository';
import { financialInput, ledgerCommandInput } from './validation';
export class LedgerService {
    constructor(readonly repository: LedgerRepository) { }
    async execute(context: CommandContext, raw: LedgerCommand): Promise<LedgerEntry | LedgerComment> {
        const parsed = ledgerCommandInput.safeParse(raw);
        if (!parsed.success) throw new ValidationError('entry', parsed.error.issues[0]!.message);
        const command = parsed.data;
        if (command.operationId !== context.operationId) throw new ValidationError('operationId', 'Command and context operation identities must agree');
        switch (command.action) {
            case 'create': return this.change(context, 'create', undefined, command.entry);
            case 'correct': return this.change({ ...context, expectedVersion: command.expectedVersion }, 'correct', command.entryId, command.entry);
            case 'void': return this.voidEntry({ ...context, expectedVersion: command.expectedVersion }, command.entryId);
            case 'restore': return this.restoreEntry({ ...context, expectedVersion: command.expectedVersion }, command.entryId);
            case 'comment': return this.addComment({ ...context, expectedVersion: command.expectedVersion }, command.entryId, command.text);
            case 'post': return this.postRule(context, command);
        }
    }
    async getEntry(context: CommandContext, entryId: string): Promise<LedgerEntry> {
        await this.repository.authorize(context, 'ledger_get');
        const entry = await this.repository.getEntry(context.householdId, entryId);
        await this.repository.authorize(context, 'ledger_get');
        return entry;
    }
    createExpense(context: CommandContext, input: ExpenseInput) { return this.change(context, 'create', undefined, input); }
    createRefund(context: CommandContext, input: RefundInput) { return this.change(context, 'create', undefined, input); }
    createPayment(context: CommandContext, input: PaymentInput) { return this.change(context, 'create', undefined, input); }
    correctExpense(context: CommandContext, entryId: string, input: ExpenseInput) { return this.change(context, 'correct', entryId, input); }
    correctEntry(context: CommandContext, entryId: string, input: FinancialInput) { return this.change(context, 'correct', entryId, input); }
    voidEntry(context: CommandContext, entryId: string) { return this.change(context, 'void', entryId); }
    restoreEntry(context: CommandContext, entryId: string) { return this.change(context, 'restore', entryId); }
    async addComment(context: CommandContext, entryId: string, text: string): Promise<LedgerComment> {
        const parsed = ledgerCommandInput.safeParse({ operationId: context.operationId, action: 'comment', entryId, expectedVersion: context.expectedVersion, text });
        if (!parsed.success || parsed.data.action !== 'comment') throw new ValidationError('comment', parsed.success ? 'Invalid comment' : parsed.error.issues[0]!.message);
        const commentText = parsed.data.text;
        const begin = () => this.repository.beginComment(context, entryId, commentText);
        const admission = await begin();
        if (admission.replay) return admission.replay;
        try {
            const entry = await this.readForWrite(context, entryId, 'ledger_comment');
            if (entry.version !== context.expectedVersion) throw new ConflictError('ledger_entry', entryId, context.expectedVersion!, entry.version, entry);
        } catch (error) {
            const { replay } = await begin();
            if (replay) return replay;
            throw error;
        }
        const comment: LedgerComment = { id: createId(), entryId, observedVersion: context.expectedVersion!, authorId: context.actorId, text: commentText, acceptedAt: new Date().toISOString() };
        return this.repository.acceptComment(admission.command, comment, context.expectedVersion!);
    }
    private async postRule(context: CommandContext, input: Extract<LedgerCommand, { action: 'post' }>): Promise<LedgerEntry> {
        const begin = () => this.repository.begin(context, 'ledger.entry.posted', undefined, input);
        const admission = await begin();
        if (admission.replay) return admission.replay;
        let source: RecurringPostingSource;
        try {
            source = await this.repository.postingBasis(context.householdId, input.ruleId, input.expectedRuleVersion, input.period);
        } catch (error) {
            const { replay } = await begin();
            if (replay) return replay;
            throw error;
        }
        await this.repository.authorize(context, 'ledger_post');
        const intent: ExpenseInput = {
            kind: 'expense', date: input.date, description: input.description ?? source.snapshot.name,
            currency: source.snapshot.currency, totalMinor: source.snapshot.totalMinor,
            payers: input.payers, category: input.category, notes: input.notes,
            allocation: { kind: 'split', split: { mode: 'exact', participants: source.snapshot.shares.map(p => ({ kind: 'fixed', ...p })) } },
        };
        // Validate both the resolved catalog basis and the caller's actual payer side.
        const parsed = financialInput.safeParse(intent);
        if (!parsed.success) throw new ValidationError('entry', parsed.error.issues[0]!.message);
        return this.accept(context, admission.command, 'post', null, parsed.data, source);
    }
    private async change(context: CommandContext, action: LedgerRevision['action'], entryId?: string, input?: FinancialInput): Promise<LedgerEntry> {
        const parsed = input === undefined ? undefined : financialInput.safeParse(input);
        if (parsed && !parsed.success) throw new ValidationError('entry', parsed.error.issues[0]!.message);
        const intent = parsed?.success ? parsed.data as FinancialInput : undefined;
        if (action !== 'create' && (!Number.isSafeInteger(context.expectedVersion) || (context.expectedVersion ?? 0) < 1)) throw new ValidationError('expectedVersion', 'Provide the version you last read');
        const event = { create: 'created', correct: 'corrected', void: 'voided', restore: 'restored', post: 'posted' }[action];
        const begin = () => this.repository.begin(context, `ledger.entry.${event}`, entryId, { action, entryId, entry: intent });
        const admission = await begin();
        if (admission.replay) return admission.replay;
        let before: LedgerEntry | null;
        try {
            before = entryId ? await this.readForWrite(context, entryId, admission.command.policyAction) : null;
            await this.repository.authorize(context, admission.command.policyAction);
            if (before && before.version !== context.expectedVersion) throw new ConflictError('ledger_entry', before.id, context.expectedVersion!, before.version, before);
            if (before && intent && (before.intent.kind !== intent.kind || (before.intent.kind === 'refund' && intent.kind === 'refund' && before.intent.expenseId !== intent.expenseId))) throw new ValidationError('entry', 'Correction must retain entry kind and original expense');
            if (before && ((action === 'restore' && before.lifecycle !== 'void') || (action !== 'restore' && before.lifecycle !== 'effective'))) throw new ValidationError('lifecycle', 'This transition is not available for the current lifecycle');
            if (before && before.version >= Number.MAX_SAFE_INTEGER) throw new ValidationError('version', 'The financial version limit has been reached');
        } catch (error) {
            // Another identical attempt may have committed since the first lookup.
            const { replay } = await begin();
            if (replay) return replay;
            throw error;
        }
        return this.accept(context, admission.command, action, before, intent, before?.source);
    }
    private async readForWrite(context: CommandContext, entryId: string, action: import('../auth/permissions').Action): Promise<LedgerEntry> {
        try { return await this.repository.getEntry(context.householdId, entryId); }
        finally { await this.repository.authorize(context, action); }
    }
    private async accept(context: CommandContext, command: import('../platform/household-command').HouseholdCommand, action: LedgerRevision['action'], before: LedgerEntry | null, intent?: FinancialInput, source?: RecurringPostingSource): Promise<LedgerEntry> {
        const now = new Date().toISOString();
        const resolved = intent?.kind === 'expense' ? resolveExpense(intent) : intent?.kind === 'refund' ? { payers: intent.payers, shares: intent.shares } : { payers: [], shares: [] };
        const after: LedgerEntry = intent ? {
            id: before?.id ?? createId(), householdId: context.householdId, version: (before?.version ?? 0) + 1,
            lifecycle: 'effective', intent, payers: resolved.payers, shares: resolved.shares,
            ...('itemized' in resolved && resolved.itemized ? { itemized: resolved.itemized } : {}),
            ...(source ? { source } : {}), createdAt: before?.createdAt ?? now, updatedAt: now,
        } : { ...before!, version: before!.version + 1, lifecycle: action === 'void' ? 'void' : 'effective', updatedAt: now };
        const transitions = [
            ...(before?.lifecycle === 'effective' ? effects(before, -1).map(e => ({ ...e, version: after.version, effectKind: 'reversal' as const })) : []),
            ...(after.lifecycle === 'effective' ? effects(after).map(e => ({ ...e, effectKind: 'replacement' as const })) : []),
        ];
        return this.repository.accept({ command, before, after, revision: { entryId: after.id, version: after.version, actorId: context.actorId, origin: context.source === 'mcp' ? 'mcp' : 'app', operationId: context.operationId, action, acceptedAt: now, snapshot: after, transitions } });
    }
}
