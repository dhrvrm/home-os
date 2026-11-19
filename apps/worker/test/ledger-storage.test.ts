import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { D1Migration } from 'cloudflare:test';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
import { countedD1 } from './d1-budget';
let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const service = (db = ledgerDB) => new LedgerService(new D1LedgerRepository(db));
it('keeps populated original tables and household/member foreign keys', async () => {
    const migrations = (env as unknown as {
        TEST_MIGRATIONS: D1Migration[];
    }).TEST_MIGRATIONS;
    const additive = migrations.find(m => m.name.includes('0012'))!;
    // Reapply only the additive migration in this file's isolated D1 after legacy data exists.
    await ledgerDB.batch(['ledger_sources', 'ledger_comments', 'ledger_allocations', 'ledger_effects', 'ledger_revisions', 'ledger_entries', 'ledger_financial_revisions'].map(table => ledgerDB.prepare(`DROP TABLE ${table}`)));
    await ledgerDB.batch([ledgerDB.prepare('DROP INDEX members_household_identity'), ledgerDB.prepare('DROP INDEX expense_rules_household_identity')]);
    await ledgerDB.prepare("INSERT INTO inventory_items(id,household_id,name,normalized_name,location,unit,tracking_mode,quantity,stock_level,level_percent,min_quantity,created_at,updated_at) VALUES('ledger-legacy','home','Rice','rice','Kitchen','kg','exact',3,'full',100,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
    await ledgerDB.batch([ledgerDB.prepare("INSERT INTO expense_rules(id,household_id,name,amount_minor,currency,cadence_unit,cadence_interval,anchor_date,created_at,updated_at) VALUES('ledger-old-rule','home','Rent',3000,'INR','month',1,'2026-01-01',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"), ledgerDB.prepare("INSERT INTO expense_participants(rule_id,member_id,position) VALUES('ledger-old-rule','ledger-b',0)")]);
    const legacyBefore = await ledgerDB.prepare("SELECT * FROM expense_rules WHERE id='ledger-old-rule'").first();
    const sessionBefore = await ledgerDB.prepare("SELECT * FROM auth_sessions WHERE member_id='local-owner'").first();
    await ledgerDB.batch(additive.queries.map(query => ledgerDB.prepare(query)));
    expect(await ledgerDB.prepare("SELECT * FROM expense_rules WHERE id='ledger-old-rule'").first()).toEqual(legacyBefore);
    expect(await ledgerDB.prepare("SELECT * FROM auth_sessions WHERE member_id='local-owner'").first()).toEqual(sessionBefore);
    expect(await ledgerDB.prepare("SELECT member_id FROM expense_participants WHERE rule_id='ledger-old-rule'").first('member_id')).toBe('ledger-b');
    const a = await service().createExpense(context('fk-create'), bill());
    expect(await ledgerDB.prepare("SELECT quantity FROM inventory_items WHERE id='ledger-legacy'").first('quantity')).toBe(3);
    await ledgerDB.batch([
        ledgerDB.prepare("INSERT INTO households(id,name,created_at,updated_at) VALUES('other-home','Other',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
        ledgerDB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES('foreign-member','other-home','Foreign','member',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    ]);
    await expect(service().createExpense(context('fk-cross'), bill(100, { payers: [{ memberId: 'foreign-member', amountMinor: 100 }] }))).rejects.toMatchObject({ status: 400 });
    await expect(ledgerDB.prepare("INSERT INTO ledger_effects(household_id,entry_id,version,effect_kind,member_id,currency,amount_minor) VALUES('home',?,1,'reversal','foreign-member','INR',1)").bind(a.id).run()).rejects.toThrow();
    expect((await ledgerDB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
it('guards the financial revision counter before its unsafe next value', async () => {
    await ledgerDB.prepare("INSERT INTO ledger_financial_revisions(household_id,revision) VALUES('home',9007199254740991) ON CONFLICT(household_id) DO UPDATE SET revision=excluded.revision").run();
    const before = await ledgerDB.prepare('SELECT count(*) n FROM ledger_entries').first('n');
    await expect(service().createExpense(context('counter-limit'), bill())).rejects.toMatchObject({ status: 400 });
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_entries').first('n')).toBe(before);
    expect(await ledgerDB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id='counter-limit'").first('n')).toBe(0);
    expect(await ledgerDB.prepare("SELECT revision FROM ledger_financial_revisions WHERE household_id='home'").first('revision')).toBe(Number.MAX_SAFE_INTEGER);
    await ledgerDB.prepare("UPDATE ledger_financial_revisions SET revision=0 WHERE household_id='home'").run();
});
it('measures bounded success, refusal and authorized replay below fifty D1 calls', async () => {
    const people = ['local-owner', 'ledger-b', ...Array.from({ length: 10 }, (_, i) => `budget-person-${i}`)];
    await ledgerDB.batch(people.slice(2).map(id => ledgerDB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES(?,'home',?,'viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, id)));
    const input = bill(100, { payers: people.map((memberId, i) => ({ memberId, amountMinor: i < 4 ? 9 : 8 })), allocation: { kind: 'itemized', participantOrder: people, items: Array.from({ length: 40 }, (_, i) => ({ label: `Line ${i}`, unitPriceMinor: i === 0 ? 100 : 0, quantity: '1', split: { mode: 'equal', participants: people.map(memberId => ({ memberId, kind: 'equal' as const })) } })) } });
    const counted = countedD1(ledgerDB), s = service(counted.database);
    const a = await s.createExpense(context('budget-create'), input);
    const success = counted.calls();
    expect(success).toBeLessThanOrEqual(50);
    await s.createExpense(context('budget-create'), input);
    const replay = counted.calls() - success;
    expect(replay).toBeLessThanOrEqual(50);
    const previous = counted.calls();
    await expect(s.correctExpense(context('budget-conflict', 99), a.id, input)).rejects.toMatchObject({ status: 409 });
    const stale = counted.calls() - previous;
    expect(stale).toBeLessThanOrEqual(50);
    const previous2 = counted.calls();
    await expect(s.createExpense(context('budget-refusal'), { ...input, payers: [{ memberId: 'not-in-this-household', amountMinor: 100 }] })).rejects.toMatchObject({ status: 400 });
    const refusal = counted.calls() - previous2;
    expect(refusal).toBeLessThanOrEqual(50);
    console.info('U2 D1 binding requests; OAuth KV=0', { success, replay, stale, refusal });
});
it('refuses a restored bill when aggregate capacity filled after void, atomically', async () => {
    const a = await service().createExpense(context('capacity-create'), bill());
    await service().voidEntry(context('capacity-void', 1), a.id);
    // Compress a reachable many-entry aggregate into one fixture head. Individual entry
    // bounds are tested separately; this isolates exact SUM and acceptance races cheaply.
    await ledgerDB.prepare('PRAGMA ignore_check_constraints=ON').run();
    await ledgerDB.prepare("INSERT INTO ledger_entries(household_id,id,kind,version,lifecycle,currency,total_minor,created_at,updated_at) VALUES('home','capacity-fixture','expense',1,'effective','INR',9007199254740991,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
    await ledgerDB.prepare('PRAGMA ignore_check_constraints=OFF').run();
    const n = await ledgerDB.prepare('SELECT count(*) n FROM ledger_revisions WHERE entry_id=?').bind(a.id).first('n');
    await expect(service().restoreEntry(context('capacity-restore', 2), a.id)).rejects.toMatchObject({ status: 400 });
    expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_revisions WHERE entry_id=?').bind(a.id).first('n')).toBe(n);
    expect((await service().getEntry(context('capacity-read'), a.id)).lifecycle).toBe('void');
    await ledgerDB.prepare("UPDATE ledger_entries SET lifecycle='void' WHERE id='capacity-fixture'").run();
});
it('does not disclose an accepted receipt after its exact delegated grant changes', async () => {
    const id = 'd'.repeat(32);
    await ledgerDB.prepare("INSERT INTO mcp_connections(id,member_id,household_id,credential_version,client_id,client_name,resource,approved_role,status,provider_grant_id,created_at,established_at,exchange_until) VALUES(?,'local-owner','home',1,'ledger-client','Ledger','https://home-os.test/mcp','member','active','ledger-provider',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2099-01-01')").bind(id).run();
    const c = context('delegated-create');
    c.actorType = 'mcp';
    c.source = 'mcp';
    c.authority!.proof = { kind: 'delegated', connectionId: id, credentialVersion: 1, ceiling: 'member' };
    const a = await service().createExpense(c, bill());
    expect(await service().createExpense(c, bill())).toEqual(a);
    await ledgerDB.prepare("UPDATE mcp_connections SET approved_role='viewer' WHERE id=?").bind(id).run();
    await expect(service().createExpense(c, bill())).rejects.toMatchObject({ status: 403 });
    await expect(service().getEntry(c, a.id)).rejects.toMatchObject({ status: 403 });
});
it('refuses acceptance if the approved delegated ceiling changes inside the batch', async () => {
    const id = 'e'.repeat(32);
    await ledgerDB.prepare("INSERT INTO mcp_connections(id,member_id,household_id,credential_version,client_id,client_name,resource,approved_role,status,provider_grant_id,created_at,established_at,exchange_until) VALUES(?,'local-owner','home',1,'ledger-client','Ledger','https://home-os.test/mcp','member','active','ledger-provider-race',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2099-01-01')").bind(id).run();
    const c = context('delegated-race');
    c.actorType = 'mcp';
    c.source = 'mcp';
    c.authority!.proof = { kind: 'delegated', connectionId: id, credentialVersion: 1, ceiling: 'member' };
    const db = beforeBatch(ledgerDB, () => ledgerDB.prepare("UPDATE mcp_connections SET approved_role='owner' WHERE id=?").bind(id).run());
    await expect(service(db).createExpense(c, bill())).rejects.toMatchObject({ status: 403 });
    expect(await ledgerDB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id='delegated-race'").first('n')).toBe(0);
});
it('accepts the exact aggregate boundary and refuses competing create/correct/restore overflow', async () => {
    const seed = 'boundary-fixture';
    const existing = await ledgerDB.prepare("SELECT COALESCE(SUM(total_minor),0) n FROM ledger_entries WHERE household_id='home' AND lifecycle='effective' AND currency='INR'").first<number>('n');
    await ledgerDB.prepare('PRAGMA ignore_check_constraints=ON').run();
    await ledgerDB.prepare("INSERT INTO ledger_entries(household_id,id,kind,version,lifecycle,currency,total_minor,created_at,updated_at) VALUES('home',?,'expense',1,'effective','INR',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(seed, Number.MAX_SAFE_INTEGER - existing! - 100).run();
    await ledgerDB.prepare('PRAGMA ignore_check_constraints=OFF').run();
    const a = await service().createExpense(context('boundary-create'), bill(100));
    const sum = () => ledgerDB.prepare("SELECT SUM(total_minor) n FROM ledger_entries WHERE household_id='home' AND lifecycle='effective' AND currency='INR'").first<number>('n');
    expect(await sum()).toBe(Number.MAX_SAFE_INTEGER);
    await expect(service().createExpense(context('boundary-over'), bill(1))).rejects.toMatchObject({ status: 400 });
    await expect(service().correctExpense(context('boundary-correct-over', 1), a.id, bill(101))).rejects.toMatchObject({ status: 400 });
    await service().correctExpense(context('boundary-currency', 1), a.id, bill(100, { currency: 'USD' }));
    expect(await sum()).toBe(Number.MAX_SAFE_INTEGER - 100);
    const race = await Promise.allSettled([service().createExpense(context('boundary-race-a'), bill(100)), service().createExpense(context('boundary-race-b'), bill(100))]);
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await sum()).toBe(Number.MAX_SAFE_INTEGER);
    await expect(service().correctExpense(context('boundary-currency-back', 2), a.id, bill(100))).rejects.toMatchObject({ status: 400 });
    const accepted = race.find((r): r is PromiseFulfilledResult<import('../src/ledger/model').LedgerEntry> => r.status === 'fulfilled')!.value;
    await service().voidEntry(context('boundary-free', 1), accepted.id);
    const restored = await Promise.allSettled([service().restoreEntry(context('boundary-restore', 2), accepted.id), service().createExpense(context('boundary-compete'), bill(100))]);
    expect(restored.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await sum()).toBe(Number.MAX_SAFE_INTEGER);
    await ledgerDB.prepare("UPDATE ledger_entries SET lifecycle='void' WHERE id=?").bind(seed).run();
});
it('bounds entry versions and concurrent household financial counters before overflow', async () => {
    const a = await service().createExpense(context('version-limit-create'), bill());
    const snapshot = { ...a, version: Number.MAX_SAFE_INTEGER - 1 };
    await ledgerDB.batch([
        ledgerDB.prepare("INSERT INTO ledger_revisions(household_id,entry_id,version,actor_id,origin,operation_id,action,accepted_at,snapshot_json) VALUES('home',?,?,'local-owner','app','synthetic-version-limit','correct',CURRENT_TIMESTAMP,?)").bind(a.id, snapshot.version, JSON.stringify(snapshot)),
        ledgerDB.prepare('UPDATE ledger_entries SET version=? WHERE household_id=? AND id=?').bind(snapshot.version, 'home', a.id)
    ]);
    const last = await service().correctExpense(context('version-limit-last', snapshot.version), a.id, bill(120));
    expect(last.version).toBe(Number.MAX_SAFE_INTEGER);
    await expect(service().correctExpense(context('version-limit-over', last.version), a.id, bill(130))).rejects.toMatchObject({ status: 400 });
    await ledgerDB.prepare("UPDATE ledger_financial_revisions SET revision=? WHERE household_id='home'").bind(Number.MAX_SAFE_INTEGER - 1).run();
    const results = await Promise.allSettled([service().createExpense(context('counter-race-a'), bill()), service().createExpense(context('counter-race-b'), bill())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ledgerDB.prepare("SELECT revision FROM ledger_financial_revisions WHERE household_id='home'").first('revision')).toBe(Number.MAX_SAFE_INTEGER);
    for (const table of ['household_command_receipts', 'audit_events'])
        expect(await ledgerDB.prepare(`SELECT count(*) n FROM ${table} WHERE operation_id IN ('counter-race-a','counter-race-b')`).first('n')).toBe(1);
});
