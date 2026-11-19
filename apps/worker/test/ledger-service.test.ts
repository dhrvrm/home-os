import { beforeEach, expect, it } from 'vitest';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const service = (db = ledgerDB) => new LedgerService(new D1LedgerRepository(db));
it('accepts AE2 exact contributions and shares once', async () => {
    const input = bill(1000, { payers: [{ memberId: 'local-owner', amountMinor: 700 }, { memberId: 'ledger-b', amountMinor: 300 }], allocation: { kind: 'split', split: { mode: 'exact', participants: [{ memberId: 'local-owner', kind: 'fixed', amountMinor: 200 }, { memberId: 'ledger-b', kind: 'fixed', amountMinor: 800 }] } } });
    const a = await service().createExpense(context('ae2'), input);
    expect(await service().createExpense(context('ae2'), input)).toEqual(a);
    expect(await service().getEntry(context('read'), a.id)).toEqual(a);
    expect((await service().repository.currentEffects('home')).filter(e => e.entryId === a.id).map(e => e.amountMinor).sort((a, b) => a - b)).toEqual([-500, 500]);
    await expect(service().createExpense(context('ae2'), bill(120))).rejects.toMatchObject({ status: 409 });
});
it('keeps 100→120→90→void→restore current snapshots separate from retained transitions', async () => {
    const a = await service().createExpense(context('chain-create'), bill());
    await service().correctExpense(context('chain120', 1), a.id, bill(120));
    await service().correctExpense(context('chain90', 2), a.id, bill(90));
    await service().voidEntry(context('chain-void', 3), a.id);
    expect((await service().repository.currentEffects('home')).filter(e => e.entryId === a.id)).toEqual([]);
    expect(await service().restoreEntry(context('chain-restore', 4), a.id)).toMatchObject({ version: 5, lifecycle: 'effective', intent: { totalMinor: 90 } });
    const history = await service().repository.history('home', a.id);
    expect(history.map(r => r.snapshot.intent.totalMinor)).toEqual([100, 120, 90, 90, 90]);
    expect(history[1]!.transitions.filter(e => e.memberId === 'local-owner').map(e => e.amountMinor)).toEqual([-50, 60]);
    expect((await service().repository.currentEffects('home')).filter(e => e.entryId === a.id).map(e => e.amountMinor).sort((a, b) => a - b)).toEqual([-45, 45]);
    await expect(service().restoreEntry(context('active-restore', 5), a.id)).rejects.toMatchObject({ status: 400 });
});
it('accepts at most one concurrent observed-version update with no partial receipt/audit/history', async () => {
    const a = await service().createExpense(context('race-create'), bill());
    const results = await Promise.allSettled([service().correctExpense(context('race-one', 1), a.id, bill(120)), service().correctExpense(context('race-two', 1), a.id, bill(90))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_revisions WHERE entry_id=?').bind(a.id).first('n')).toBe(2);
    for (const table of ['household_command_receipts', 'audit_events'])
        expect(await ledgerDB.prepare(`SELECT count(*) n FROM ${table} WHERE operation_id IN ('race-one','race-two')`).first('n')).toBe(1);
});
it('retains departed people while refusing new inactive parties including an acceptance race', async () => {
    const a = await service().createExpense(context('depart-create'), bill());
    await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-b'").run();
    await service().correctExpense(context('depart-correct', 1), a.id, bill(120));
    await service().voidEntry(context('depart-void', 2), a.id);
    await service().restoreEntry(context('depart-restore', 3), a.id);
    await expect(service().createExpense(context('depart-new'), bill())).rejects.toMatchObject({ status: 400 });
    const db = beforeBatch(ledgerDB, () => ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-c'").run());
    await expect(service(db).createExpense(context('depart-race'), bill(100, { allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: 'ledger-c', kind: 'equal' }] } } }))).rejects.toMatchObject({ status: 400 });
    expect(await ledgerDB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id='depart-race'").first('n')).toBe(0);
});
it.each(['revoked', 'demoted', 'deactivated', 'replaced'])('refuses %s exact browser authority during acceptance and retry', async (reason) => {
    const countBefore = await ledgerDB.prepare('SELECT count(*) n FROM ledger_entries').first('n');
    const db = beforeBatch(ledgerDB, () => ledgerDB.prepare(reason === 'revoked' ? "DELETE FROM auth_sessions" : reason === 'demoted' ? "UPDATE members SET role='viewer' WHERE id='local-owner'" : reason === 'deactivated' ? "UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'" : "UPDATE auth_accounts SET credential_version=2 WHERE member_id='local-owner'").run());
    await expect(service(db).createExpense(context(`authority-${reason}`), bill())).rejects.toMatchObject({ status: 403 });
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_entries').first('n')).toBe(countBefore);
    expect(await ledgerDB.prepare('SELECT count(*) n FROM mutation_guards').first('n')).toBe(0);
    await expect(service().createExpense(context(`authority-${reason}`), bill())).rejects.toMatchObject({ status: 403 });
});
it('retains full raw itemization and resolved breakdowns immutably', async () => {
    const input = bill(110, { allocation: { kind: 'itemized', participantOrder: ['local-owner', 'ledger-b'], items: [{ label: 'Tea', unitPriceMinor: 100, quantity: '1', split: { mode: 'equal', participants: [{ memberId: 'local-owner', kind: 'equal' }, { memberId: 'ledger-b', kind: 'equal' }] } }], tax: { kind: 'percent', basisPoints: 1000 } } });
    const a = await service().createExpense(context('item-create'), input);
    const history = await service().repository.history('home', a.id);
    expect(history[0]!.snapshot.intent).toEqual(input);
    expect(history[0]!.snapshot.itemized).toMatchObject({ totalMinor: 110, taxMinor: 10 });
    await expect(ledgerDB.prepare("UPDATE ledger_revisions SET snapshot_json='{}' WHERE entry_id=?").bind(a.id).run()).rejects.toThrow();
});
it('refuses later commands without their domain guards', async () => {
    await expect(service().execute(context('later-comment'), { operationId: 'later-comment', action: 'comment', entryId: 'unknown', expectedVersion: 1, text: 'Hello' })).rejects.toMatchObject({ status: 400 });
    await expect(service().execute(context('later-payment'), { operationId: 'later-payment', action: 'create', entry: { kind: 'payment', date: '2026-11-19', currency: 'INR', totalMinor: 10, senderId: 'local-owner', receiverId: 'ledger-b', method: 'Cash' } })).rejects.toMatchObject({ status: 400 });
});
it('returns the original authorized lifecycle receipt while refusing new invalid lifecycle transitions', async () => {
    const a = await service().createExpense(context('lifecycle-create'), bill());
    const v = await service().voidEntry(context('lifecycle-void', 1), a.id);
    expect(await service().voidEntry(context('lifecycle-void', 1), a.id)).toEqual(v);
    await expect(service().voidEntry(context('lifecycle-again', 2), a.id)).rejects.toMatchObject({ status: 400 });
    await expect(service().correctExpense(context('lifecycle-correct', 2), a.id, bill(110))).rejects.toMatchObject({ status: 400 });
    const r = await service().restoreEntry(context('lifecycle-restore', 2), a.id);
    expect(await service().restoreEntry(context('lifecycle-restore', 2), a.id)).toEqual(r);
});
it('binds an operation to its admitted actor and keeps safe audit provenance', async () => {
    const input = bill();
    await service().createExpense(context('actor-bound'), input);
    const { digest } = await import('../src/auth/crypto');
    const hash = await digest('ledger-second-actor');
    await ledgerDB.batch([
        ledgerDB.prepare("INSERT INTO auth_accounts(member_id,email,password_hash,updated_at) VALUES('ledger-b','second@ledger.test','fixture',CURRENT_TIMESTAMP)"),
        ledgerDB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES(?,'ledger-b',1,'2099-01-01T00:00:00Z',CURRENT_TIMESTAMP)").bind(hash)
    ]);
    const other = context('actor-bound');
    other.actorId = 'ledger-b';
    other.authority = { householdId: 'home', memberId: 'ledger-b', role: 'member', proof: { kind: 'browser', tokenHash: hash, credentialVersion: 1 } };
    await expect(service().createExpense(other, input)).rejects.toMatchObject({ status: 409 });
    const audit = await ledgerDB.prepare("SELECT changes_json FROM audit_events WHERE operation_id='actor-bound'").first<string>('changes_json');
    expect(audit).not.toContain(hash);
    expect(audit).not.toContain('tokenHash');
    expect(audit).not.toContain('credentialVersion');
});
it('rechecks exact write authority before stale-version conflict disclosure', async () => {
    const a = await service().createExpense(context('disclosure-create'), bill());
    let reads = 0;
    const db = new Proxy(ledgerDB, { get(target, key) {
            if (key === 'prepare')
                return (sql: string) => { const statement = target.prepare(sql); if (!sql.includes('r.snapshot_json'))
                    return statement; return new Proxy(statement, { get(st, prop) { if (prop === 'bind')
                        return (...args: unknown[]) => { const bound = st.bind(...args); return new Proxy(bound, { get(b, p) { if (p === 'first')
                                return async () => { if (reads++ === 0)
                                    await ledgerDB.prepare("UPDATE members SET role='viewer' WHERE id='local-owner'").run(); return b.first(); }; const v = Reflect.get(b, p, b); return typeof v === 'function' ? v.bind(b) : v; } }); }; const v = Reflect.get(st, prop, st); return typeof v === 'function' ? v.bind(st) : v; } }); };
            const v = Reflect.get(target, key, target);
            return typeof v === 'function' ? v.bind(target) : v;
        } });
    await expect(service(db).correctExpense(context('disclosure-stale', 99), a.id, bill(120))).rejects.toMatchObject({ status: 403 });
});
