import { beforeEach, expect, it } from 'vitest';
import { LedgerQueries } from '../src/ledger/queries';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
import { countedD1 } from './d1-budget';
let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const queries = (db = ledgerDB) => new LedgerQueries(new D1LedgerQueryRepository(db), 'query-test-secret');
const commands = () => new LedgerService(new D1LedgerRepository(ledgerDB));

it('refuses malformed, tampered, differently scoped and stale financial cursors', async () => {
  await commands().createExpense(context('cursor-a'), bill());
  await commands().createExpense(context('cursor-b'), bill());
  const first = await queries().entries(context('read'), { limit: 1 });
  for (const cursor of ['!', first.nextCursor!.slice(0, -3) + 'AAA']) await expect(queries().entries(context('read'), { limit: 1, cursor })).rejects.toMatchObject({ status: 400 });
  await expect(queries().entries(context('read'), { limit: 1, cursor: first.nextCursor!, currency: 'USD' })).rejects.toMatchObject({ status: 400 });
  await commands().createExpense(context('cursor-c'), bill());
  await expect(queries().entries(context('read'), { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409, code: 'ledger_revision_changed' });
});

it('enforces safe bounded query inputs and household subjects', async () => {
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { from: '2026-02-30' }, { from: '2026-03-01', to: '2026-02-01' }, { role: 'owner' }, { search: 'x'.repeat(161) }]) await expect(queries().entries(context('read'), input)).rejects.toMatchObject({ status: 400 });
  await expect(queries().entries(context('read'), { memberId: 'not-in-household' })).rejects.toMatchObject({ status: 404 });
  await expect(queries().getEntry(context('read'), 'not-in-household')).rejects.toMatchObject({ status: 404 });
  await ledgerDB.batch([
    ledgerDB.prepare("INSERT INTO households(id,name,created_at,updated_at) VALUES('query-other-home','Other',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
    ledgerDB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES('query-foreign','query-other-home','Foreign','owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
  ]);
  await expect(queries().entries(context('read'), { memberId: 'query-foreign' })).rejects.toMatchObject({ status: 404 });
  await expect(queries().statement(context('read'), { memberId: 'query-foreign', currency: 'INR' })).rejects.toMatchObject({ status: 404 });
});

it('rechecks current exact authority after the complete snapshot, including refusal paths', async () => {
  await commands().createExpense(context('auth-create'), bill());
  const db = beforeBatch(ledgerDB, () => ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'").run());
  await expect(queries(db).entries(context('read'), {})).rejects.toMatchObject({ status: 403 });
});

it('refuses disclosure when access disappears after the read snapshot has completed', async () => {
  const db = new Proxy(ledgerDB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'").run();
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(queries(db).entries(context('read'), {})).rejects.toMatchObject({ status: 403 });
});

it('holds the exact approved delegated ceiling through disclosure', async () => {
  const id = 'a4'.repeat(16);
  await ledgerDB.prepare("INSERT INTO mcp_connections(id,member_id,household_id,credential_version,client_id,client_name,resource,approved_role,status,provider_grant_id,created_at,established_at,exchange_until) VALUES(?,'local-owner','home',1,'query-client','Query','https://home-os.test/mcp','member','active','query-grant',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'2099-01-01')").bind(id).run();
  const actor = context('read'); actor.actorType = 'mcp'; actor.source = 'mcp';
  actor.authority!.proof = { kind: 'delegated', connectionId: id, credentialVersion: 1, ceiling: 'member' };
  await expect(queries().balances(actor, {})).resolves.toHaveProperty('revision');
  const db = new Proxy(ledgerDB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      await ledgerDB.prepare("UPDATE mcp_connections SET approved_role='owner' WHERE id=?").bind(id).run();
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(queries(db).balances(actor, {})).rejects.toMatchObject({ status: 403 });
});

it('measures complete report, detail, malformed and missing-subject paths under fifty D1 calls', async () => {
  const a = await commands().createExpense(context('budget-query'), bill());
  const budgets: Record<string, number> = {};
  for (const [name, run] of Object.entries({
    entries: (q: LedgerQueries) => q.entries(context('read'), {}), balances: (q: LedgerQueries) => q.balances(context('read'), {}),
    repayments: (q: LedgerQueries) => q.repayments(context('read'), {}), summaries: (q: LedgerQueries) => q.summaries(context('read'), {}),
    statement: (q: LedgerQueries) => q.statement(context('read'), { memberId: 'ledger-b', currency: 'INR' }),
    export: (q: LedgerQueries) => q.export(context('read'), { memberId: 'ledger-b', currency: 'INR', format: 'csv' }),
    detail: (q: LedgerQueries) => q.getEntry(context('read'), a.id), history: (q: LedgerQueries) => q.history(context('read'), a.id, {}),
    comments: (q: LedgerQueries) => q.comments(context('read'), a.id, {}), status: (q: LedgerQueries) => q.operationStatus(context('read'), 'budget-query'),
  })) { const counted = countedD1(ledgerDB, 50, true); await run(queries(counted.database)); budgets[name] = counted.calls(); expect(counted.calls()).toBeLessThanOrEqual(50); }
  const missing = countedD1(ledgerDB, 50, true);
  await expect(queries(missing.database).entries(context('read'), { memberId: 'missing' })).rejects.toMatchObject({ status: 404 });
  budgets.missing = missing.calls();
  const malformed = countedD1(ledgerDB, 50, true);
  await expect(queries(malformed.database).entries(context('read'), { limit: 51 })).rejects.toMatchObject({ status: 400 });
  budgets.malformed = malformed.calls();
  const tampered = countedD1(ledgerDB, 50, true);
  await expect(queries(tampered.database).entries(context('read'), { cursor: 'bad' })).rejects.toMatchObject({ status: 400 });
  budgets.tampered = tampered.calls();
  const forbidden = countedD1(ledgerDB, 50, true);
  await expect(queries(forbidden.database).entries({ ...context('read'), actorId: 'ledger-b' }, {})).rejects.toMatchObject({ status: 403 });
  budgets.forbidden = forbidden.calls();
  const first = await queries().entries(context('read'), { limit: 1 });
  await commands().createExpense(context('budget-stale'), bill());
  const stale = countedD1(ledgerDB, 50, true);
  await expect(queries(stale.database).entries(context('read'), { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  budgets.stale = stale.calls();
  console.info('U4 conservative D1 statement budget, OAuth KV=0', budgets);
});
