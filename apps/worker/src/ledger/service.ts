import type { CommandContext } from '../platform/context';
import { ConflictError, ValidationError } from '../platform/errors';
import { createId } from '../platform/ids';
import { resolveExpense } from './allocation';
import type { ExpenseInput, LedgerCommand, LedgerEffect, LedgerEntry, LedgerRevision } from './model';
import type { LedgerRepository } from './repository';
import { expenseInput, ledgerCommandInput } from './validation';
export class LedgerService {
    constructor(readonly repository: LedgerRepository) { }
    async execute(context: CommandContext, raw: LedgerCommand): Promise<LedgerEntry> {
        const parsed = ledgerCommandInput.safeParse(raw);
        if (!parsed.success)
            throw new ValidationError('entry', parsed.error.issues[0]!.message);
        const command = parsed.data;
        if (command.operationId !== context.operationId)
            throw new ValidationError('operationId', 'Command and context operation identities must agree');
        switch (command.action) {
            case 'create':
                if (command.entry.kind === 'expense')
                    return this.createExpense(context, command.entry);
                break;
            case 'correct':
                if (command.entry.kind === 'expense')
                    return this.correctExpense({ ...context, expectedVersion: command.expectedVersion }, command.entryId, command.entry);
                break;
            case 'void': return this.voidEntry({ ...context, expectedVersion: command.expectedVersion }, command.entryId);
            case 'restore': return this.restoreEntry({ ...context, expectedVersion: command.expectedVersion }, command.entryId);
        }
        throw new ValidationError('action', 'This ledger command is not available');
    }
    async getEntry(context: CommandContext, entryId: string): Promise<LedgerEntry> {
        await this.repository.authorize(context, 'ledger_get');
        const entry = await this.repository.getEntry(context.householdId, entryId);
        await this.repository.authorize(context, 'ledger_get');
        return entry;
    }
    createExpense(context: CommandContext, input: ExpenseInput) { return this.change(context, 'create', undefined, input); }
    correctExpense(context: CommandContext, entryId: string, input: ExpenseInput) { return this.change(context, 'correct', entryId, input); }
    voidEntry(context: CommandContext, entryId: string) { return this.change(context, 'void', entryId); }
    restoreEntry(context: CommandContext, entryId: string) { return this.change(context, 'restore', entryId); }
    private async change(context: CommandContext, action: LedgerRevision['action'], entryId?: string, input?: ExpenseInput): Promise<LedgerEntry> {
        const parsed = input === undefined ? undefined : expenseInput.safeParse(input);
        if (parsed && !parsed.success)
            throw new ValidationError('entry', parsed.error.issues[0]!.message);
        const intent = parsed?.success ? parsed.data as ExpenseInput : undefined;
        if (action !== 'create' && (!Number.isSafeInteger(context.expectedVersion) || (context.expectedVersion ?? 0) < 1))
            throw new ValidationError('expectedVersion', 'Provide the version you last read');
        const event = { create: 'created', correct: 'corrected', void: 'voided', restore: 'restored', post: 'posted' }[action];
        const admission = await this.repository.begin(context, `ledger.entry.${event}`, entryId, { action, entryId, entry: intent });
        if (admission.replay)
            return admission.replay;
        const before = entryId ? await this.repository.getEntry(context.householdId, entryId) : null;
        await this.repository.authorize(context, admission.command.policyAction);
        if (before && before.version !== context.expectedVersion) {
            throw new ConflictError('ledger_entry', before.id, context.expectedVersion!, before.version, before);
        }
        if (before?.intent.kind !== 'expense' && before)
            throw new ValidationError('entry', 'This lifecycle currently supports ordinary expenses');
        if (before && ((action === 'restore' && before.lifecycle !== 'void') || (action !== 'restore' && before.lifecycle !== 'effective')))
            throw new ValidationError('lifecycle', 'This transition is not available for the current lifecycle');
        if (before && before.version >= Number.MAX_SAFE_INTEGER)
            throw new ValidationError('version', 'The financial version limit has been reached');
        const now = new Date().toISOString();
        const resolved = intent ? resolveExpense(intent) : null;
        const after: LedgerEntry = intent ? {
            id: before?.id ?? createId(),
            householdId: context.householdId,
            version: (before?.version ?? 0) + 1,
            lifecycle: 'effective',
            intent,
            payers: resolved!.payers,
            shares: resolved!.shares,
            ...(resolved!.itemized ? { itemized: resolved!.itemized } : {}),
            ...(before?.source ? { source: before.source } : {}),
            createdAt: before?.createdAt ?? now,
            updatedAt: now,
        } : {
            ...before!,
            version: before!.version + 1,
            lifecycle: action === 'void' ? 'void' : 'effective',
            updatedAt: now,
        };
        const transitions = [
            ...(before?.lifecycle === 'effective'
                ? effects(before, -1).map(e => ({ ...e, version: after.version, effectKind: 'reversal' as const }))
                : []),
            ...(after.lifecycle === 'effective'
                ? effects(after).map(e => ({ ...e, effectKind: 'replacement' as const }))
                : []),
        ];
        return this.repository.accept({
            command: admission.command,
            before,
            after,
            revision: {
                entryId: after.id,
                version: after.version,
                actorId: context.actorId,
                origin: context.source === 'mcp' ? 'mcp' : 'app',
                operationId: context.operationId,
                action,
                acceptedAt: now,
                snapshot: after,
                transitions,
            },
        });
    }
}
/** Combine paid and allocated sides once; zero effects retain named participants. */
export function effects(entry: LedgerEntry, direction: 1 | -1 = 1): LedgerEffect[] {
    const net = new Map<string, number>();
    for (const p of entry.payers)
        net.set(p.memberId, (net.get(p.memberId) ?? 0) + p.amountMinor);
    for (const p of entry.shares)
        net.set(p.memberId, (net.get(p.memberId) ?? 0) - p.amountMinor);
    return [...net].map(([memberId, amountMinor]) => ({ entryId: entry.id, version: entry.version, memberId, currency: entry.intent.currency, amountMinor: amountMinor * direction }));
}
