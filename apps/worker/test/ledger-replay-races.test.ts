import { beforeEach, expect, it } from 'vitest';
import { digest } from '../src/auth/crypto';
import { D1ExpenseRepository } from '../src/expenses/catalog/d1-repository';
import { ExpenseService } from '../src/expenses/catalog/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import type { LedgerCommand, LedgerComment, LedgerEntry } from '../src/ledger/model';
import type { LedgerRepository } from '../src/ledger/repository';
import { LedgerService } from '../src/ledger/service';
import type { CommandContext } from '../src/platform/context';
import { countedD1 } from './d1-budget';
import { bill, ledgerDB, ledgerFixture } from './ledger-fixtures';

let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => {
    const fixture = await ledgerFixture();
    const prefix = crypto.randomUUID();
    context = (operationId, version) => fixture(operationId.startsWith(prefix) ? operationId : `${prefix}-${operationId}`, version);
});
const service = () => new LedgerService(new D1LedgerRepository(ledgerDB));
const rules = () => new ExpenseService(new D1ExpenseRepository(ledgerDB));

// Real D1 performs every lookup and acceptance. Only scheduling is controlled:
// the winner commits after the loser's first empty receipt lookup, before its read.
function afterEmptyBegin(repository: LedgerRepository, winner: () => Promise<void>, beforeRecovery?: () => Promise<void>) {
    let injected = false;
    return new Proxy(repository, {
        get(target, key) {
            if (key === 'begin' || key === 'beginComment') return async (...args: unknown[]) => {
                if (injected) await beforeRecovery?.();
                const admission = await Reflect.apply(target[key], target, args) as Awaited<ReturnType<LedgerRepository['begin'] | LedgerRepository['beginComment']>>;
                if (!injected) {
                    injected = true;
                    expect(admission.replay).toBeNull();
                    await winner();
                }
                return admission;
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function racingService(winner: () => Promise<void>, beforeRecovery?: () => Promise<void>) {
    const counted = countedD1(ledgerDB);
    return { service: new LedgerService(afterEmptyBegin(new D1LedgerRepository(counted.database), winner, beforeRecovery)), calls: counted.calls };
}

async function oneAcceptance(operationId: string) {
    operationId = context(operationId).operationId;
    for (const table of ['household_command_receipts', 'audit_events']) {
        expect(await ledgerDB.prepare(`SELECT count(*) n FROM ${table} WHERE household_id='home' AND operation_id=?`).bind(operationId).first('n')).toBe(1);
    }
    expect(await ledgerDB.prepare('SELECT count(*) n FROM mutation_guards').first('n')).toBe(0);
}

const transitionCases = (['correct', 'void', 'restore'] as const).flatMap(action => (['direct', 'execute'] as const).map(surface => ({ action, surface })));
it.each(transitionCases)('replays $action through $surface when an identical winner makes the read stale', async ({ action, surface }) => {
    const original = await service().createExpense(context('transition-original'), bill());
    if (action === 'restore') await service().voidEntry(context('transition-prevoid', 1), original.id);
    const expectedVersion = action === 'restore' ? 2 : 1;
    const operationId = context(`transition-${action}-${surface}`).operationId;
    const command: LedgerCommand = action === 'correct'
        ? { operationId, action, entryId: original.id, expectedVersion, entry: bill(120) }
        : { operationId, action, entryId: original.id, expectedVersion };
    const run = (ledger: LedgerService) => surface === 'execute' ? ledger.execute(context(operationId), command)
        : action === 'correct' ? ledger.correctEntry(context(operationId, expectedVersion), original.id, bill(120))
        : action === 'void' ? ledger.voidEntry(context(operationId, expectedVersion), original.id)
        : ledger.restoreEntry(context(operationId, expectedVersion), original.id);
    let accepted: LedgerEntry | LedgerComment | undefined;
    const loser = racingService(async () => { accepted = await run(service()); });
    const result = await run(loser.service);
    expect(result).toEqual(accepted);
    expect(await run(service())).toEqual(accepted);
    expect((await service().getEntry(context('transition-read'), original.id)).version).toBe(expectedVersion + 1);
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_revisions WHERE entry_id=?').bind(original.id).first('n')).toBe(expectedVersion + 1);
    await oneAcceptance(operationId);
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

it.each(['direct', 'execute'] as const)('replays an identical comment through %s after its parent is corrected', async surface => {
    const original = await service().createExpense(context('comment-original'), bill());
    const operationId = context(`comment-race-${surface}`).operationId;
    const command = { operationId, action: 'comment' as const, entryId: original.id, expectedVersion: 1, text: 'Accepted explanation' };
    const run = (ledger: LedgerService) => surface === 'execute' ? ledger.execute(context(operationId), command)
        : ledger.addComment(context(operationId, 1), original.id, command.text);
    let accepted: LedgerEntry | LedgerComment | undefined;
    const loser = racingService(async () => {
        accepted = await run(service());
        await service().correctExpense(context('comment-parent-correct', 1), original.id, bill(120));
    });
    const result = await run(loser.service);
    expect(result).toEqual(accepted);
    expect(result).toMatchObject({ observedVersion: 1, text: command.text });
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_comments WHERE entry_id=?').bind(original.id).first('n')).toBe(1);
    expect((await service().getEntry(context('comment-read'), original.id)).version).toBe(2);
    await oneAcceptance(operationId);
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

async function posting(operationId: string): Promise<Extract<LedgerCommand, { action: 'post' }>> {
    operationId = context(operationId).operationId;
    const rule = await rules().createRule(context('posting-rule'), {
        name: 'Rent', amountMinor: 100, currency: 'INR', cadence: { unit: 'month', interval: 1, anchorDate: '2026-01-01' },
        participants: [{ memberId: 'ledger-b' }, { memberId: 'local-owner' }],
    });
    return { operationId, action: 'post', ruleId: rule.id, expectedRuleVersion: 1, period: 0, date: '2026-11-19', payers: [{ memberId: 'local-owner', amountMinor: 100 }] };
}

it.each(['changed', 'archived', 'departed participant'] as const)('replays the accepted posting when its rule has a %s basis before the loser reads', async reason => {
    const command = await posting('posting-race');
    let accepted: LedgerEntry | LedgerComment | undefined;
    const loser = racingService(async () => {
        accepted = await service().execute(context(command.operationId), command);
        if (reason === 'changed') await rules().updateRule(context('rule-changed', 1), command.ruleId, { name: 'Changed rent' });
        else if (reason === 'archived') await rules().archiveRule(context('rule-archived', 1), command.ruleId);
        else await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-b'").run();
    });
    expect(await loser.service.execute(context(command.operationId), command)).toEqual(accepted);
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_sources WHERE rule_id=?').bind(command.ruleId).first('n')).toBe(1);
    await oneAcceptance(command.operationId);
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

it.each(['entry', 'entry version', 'comment', 'comment version', 'posting'] as const)('refuses changed %s intent when the receipt appears after the first lookup', async kind => {
    const original = await service().createExpense(context('changed-original'), bill());
    const operationId = context('changed-intent').operationId;
    let run: (ledger: LedgerService) => Promise<LedgerEntry | LedgerComment>;
    let winner: () => Promise<void>;
    if (kind === 'posting') {
        const command = await posting(operationId);
        run = ledger => ledger.execute(context(operationId), { ...command, period: 1 });
        winner = async () => {
            await service().execute(context(operationId), command);
            await rules().archiveRule(context('changed-rule-archive', 1), command.ruleId);
        };
    } else if (kind.startsWith('comment')) {
        run = ledger => ledger.addComment(context(operationId, kind === 'comment version' ? 99 : 1), original.id, kind === 'comment' ? 'Changed text' : 'Original text');
        winner = async () => {
            await service().addComment(context(operationId, 1), original.id, 'Original text');
            await service().correctExpense(context('changed-parent', 1), original.id, bill(120));
        };
    } else {
        run = ledger => ledger.correctExpense(context(operationId, kind === 'entry version' ? 99 : 1), original.id, bill(kind === 'entry' ? 90 : 120));
        winner = async () => { await service().correctExpense(context(operationId, 1), original.id, bill(120)); };
    }
    const loser = racingService(winner);
    await expect(run(loser.service)).rejects.toMatchObject({ status: 409, expectedVersion: 0, actualVersion: 0, details: undefined });
    await oneAcceptance(operationId);
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

it('refuses another actor’s identical receipt during precommit recovery', async () => {
    const original = await service().createExpense(context('actor-original'), bill());
    const tokenHash = await digest('race-second-actor');
    await ledgerDB.batch([
        ledgerDB.prepare("INSERT INTO auth_accounts(member_id,email,password_hash,updated_at) VALUES('ledger-b','race-second@ledger.test','fixture',CURRENT_TIMESTAMP)"),
        ledgerDB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES(?,'ledger-b',1,'2099-01-01T00:00:00Z',CURRENT_TIMESTAMP)").bind(tokenHash),
    ]);
    const other: CommandContext = { ...context('actor-race', 1), actorId: 'ledger-b', authority: { householdId: 'home', memberId: 'ledger-b', role: 'member', proof: { kind: 'browser', tokenHash, credentialVersion: 1 } } };
    const loser = racingService(async () => { await service().correctExpense(other, original.id, bill(120)); });
    await expect(loser.service.correctExpense(context('actor-race', 1), original.id, bill(120))).rejects.toMatchObject({ status: 409, expectedVersion: 0, actualVersion: 0, details: undefined });
    await oneAcceptance('actor-race');
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

const authorityCases = (['entry', 'comment', 'posting'] as const).flatMap(kind => (['revoked', 'demoted', 'deactivated', 'replaced'] as const).map(reason => ({ kind, reason })));
it.each(authorityCases)('refuses $reason exact authority before disclosing a concurrent $kind receipt', async ({ kind, reason }) => {
    const original = await service().createExpense(context('authority-original'), bill());
    const command = kind === 'posting' ? await posting('authority-race') : undefined;
    const run = (ledger: LedgerService) => kind === 'posting' ? ledger.execute(context('authority-race'), command!)
        : kind === 'comment' ? ledger.addComment(context('authority-race', 1), original.id, 'Accepted text')
        : ledger.correctExpense(context('authority-race', 1), original.id, bill(120));
    let recovered = false;
    const loser = racingService(async () => {
        await run(service());
        if (kind === 'comment') await service().correctExpense(context('authority-parent', 1), original.id, bill(120));
        if (kind === 'posting') await rules().archiveRule(context('authority-archive', 1), command!.ruleId);
    }, async () => {
        // Authority changes after ordinary read guards passed, immediately before
        // the recovery lookup itself. An older admission cannot disclose a receipt.
        recovered = true;
        await ledgerDB.prepare(reason === 'revoked' ? 'DELETE FROM auth_sessions'
            : reason === 'demoted' ? "UPDATE members SET role='viewer' WHERE id='local-owner'"
            : reason === 'deactivated' ? "UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'"
            : "UPDATE auth_accounts SET credential_version=2 WHERE member_id='local-owner'").run();
    });
    await expect(run(loser.service)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(recovered).toBe(true);
    await oneAcceptance('authority-race');
    expect(loser.calls()).toBeLessThanOrEqual(50);
});

it('preserves ordinary unknown-operation version, lifecycle and rule refusals within the request budget', async () => {
    const original = await service().createExpense(context('unknown-original'), bill());
    const command = await posting('unknown-post');
    await rules().archiveRule(context('unknown-archive', 1), command.ruleId);
    const cases = [
        { run: (ledger: LedgerService) => ledger.correctExpense(context('unknown-correct', 99), original.id, bill(120)), error: { status: 409, actualVersion: 1, expectedVersion: 99, details: original } },
        { run: (ledger: LedgerService) => ledger.restoreEntry(context('unknown-restore', 1), original.id), error: { status: 400, field: 'lifecycle' } },
        { run: (ledger: LedgerService) => ledger.addComment(context('unknown-comment', 99), original.id, 'Unaccepted text'), error: { status: 409, actualVersion: 1, expectedVersion: 99, details: original } },
        { run: (ledger: LedgerService) => ledger.execute(context(command.operationId), command), error: { status: 409, entityType: 'expense_rule' } },
        { run: (ledger: LedgerService) => ledger.execute(context('unknown-archived-post'), { ...command, operationId: context('unknown-archived-post').operationId, expectedRuleVersion: 2 }), error: { status: 400, field: 'ruleId' } },
    ];
    for (const { run, error } of cases) {
        const counted = countedD1(ledgerDB);
        await expect(run(new LedgerService(new D1LedgerRepository(counted.database)))).rejects.toMatchObject(error);
        expect(counted.calls()).toBeLessThanOrEqual(50);
    }
    expect(await ledgerDB.prepare('SELECT count(*) n FROM household_command_receipts WHERE operation_id IN (?,?,?,?,?)').bind(...['unknown-correct', 'unknown-restore', 'unknown-comment', 'unknown-post', 'unknown-archived-post'].map(id => context(id).operationId)).first('n')).toBe(0);
});

it('measures bounded success, refusal, fresh replay and precommit recovery requests', async () => {
    const requests: Record<string, number> = {};
    const success = countedD1(ledgerDB);
    const accepted = await new LedgerService(new D1LedgerRepository(success.database)).createExpense(context('budget-create'), bill());
    requests.success = success.calls();
    const replay = countedD1(ledgerDB);
    expect(await new LedgerService(new D1LedgerRepository(replay.database)).createExpense(context('budget-create'), bill())).toEqual(accepted);
    requests.replay = replay.calls();
    const refusal = countedD1(ledgerDB);
    await expect(new LedgerService(new D1LedgerRepository(refusal.database)).restoreEntry(context('budget-refuse', 1), accepted.id)).rejects.toMatchObject({ status: 400, field: 'lifecycle' });
    requests.refusal = refusal.calls();
    const recovery = racingService(async () => { await service().correctExpense(context('budget-correct', 1), accepted.id, bill(120)); });
    await expect(recovery.service.correctExpense(context('budget-correct', 1), accepted.id, bill(120))).resolves.toMatchObject({ id: accepted.id, version: 2 });
    requests.recovery = recovery.calls();
    expect(Object.values(requests).every(count => count <= 50)).toBe(true);
    console.info('ledger replay request counts', JSON.stringify(requests));
});
