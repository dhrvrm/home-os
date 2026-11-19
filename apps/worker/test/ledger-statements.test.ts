import { beforeEach, expect, it } from 'vitest';
import { LedgerQueries } from '../src/ledger/queries';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const queries = (db = ledgerDB) => new LedgerQueries(new D1LedgerQueryRepository(db), 'query-test-secret');
const commands = () => new LedgerService(new D1LedgerRepository(ledgerDB));
const scope = { memberId: 'local-owner', currency: 'INR' as const, from: '2026-02-01', to: '2026-02-28', limit: 1 };

it('reconciles complete opening, movements, closing and exact safe CSV with continuation', async () => {
  await commands().createExpense(context('opening'), bill(100, { date: '2026-01-01' }));
  await commands().createExpense(context('range-a'), bill(120, { date: '2026-02-01', description: '=SUM(A1),"text"' }));
  await commands().createExpense(context('range-b'), bill(140, { date: '2026-02-02' }));
  await commands().createExpense(context('after'), bill(160, { date: '2026-03-01' }));
  const first = await queries().statement(context('read'), scope);
  expect(first).toMatchObject({ openingMinor: 50, movementMinor: 130, closingMinor: 180, movementCount: 2 });
  expect(first.items[0]).toMatchObject({ amountMinor: 60, runningMinor: 110 });
  const last = await queries().statement(context('read'), { ...scope, cursor: first.nextCursor! });
  expect(last.items[0]).toMatchObject({ amountMinor: 70, runningMinor: 180 });
  expect(last.nextCursor).toBeNull();
  const csv = await queries().export(context('read'), { ...scope, format: 'csv' });
  expect(csv.csv).toContain('"\'=SUM(A1),""text"""');
  expect(csv.csv).toContain('"0.60"');
  expect(csv).toMatchObject({ openingMinor: 50, movementMinor: 130, closingMinor: 180, revision: 4 });
});

it('reads first-page revision, aggregates and movements from one batch despite a correction before it', async () => {
  const scope = { memberId: 'ledger-b', currency: 'USD' as const, from: '2027-02-01', to: '2027-02-28', limit: 1 };
  const baseline = await queries().statement(context('read'), scope);
  const a = await commands().createExpense(context('race-a'), bill(100, { currency: 'USD', date: '2027-01-01' }));
  await commands().createExpense(context('race-b'), bill(100, { currency: 'USD', date: '2027-02-01' }));
  const db = beforeBatch(ledgerDB, () => commands().correctExpense(context('race-correct', 1), a.id, bill(200, { currency: 'USD', date: '2027-02-02' })));
  const page = await queries(db).statement(context('read'), scope);
  expect(page).toMatchObject({ revision: baseline.revision + 3, openingMinor: 0, movementMinor: -150, closingMinor: -150, movementCount: 2 });
  await commands().correctExpense(context('race-again', 2), a.id, bill(240, { currency: 'USD', date: '2027-01-02' }));
  await expect(queries().statement(context('read'), { ...scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'ledger_revision_changed', status: 409 });
  expect(await queries().statement(context('read'), scope)).toMatchObject({ openingMinor: -120, movementMinor: -50, closingMinor: -170 });
});

it('declares empty statements exactly, per currency', async () => {
  expect(await queries().statement(context('read'), { memberId: 'ledger-b', currency: 'JPY' })).toMatchObject({ openingMinor: 0, movementMinor: 0, closingMinor: 0, movementCount: 0, items: [], nextCursor: null });
});

it('keeps the last minor unit through SQL aggregates, suggestions and signed CSV at the exact safe bound', async () => {
  // Compress a reachable many-entry aggregate into one projection to exercise SUM
  // and formatting cheaply. This intentionally exceeds per-entry constraints and
  // is query-only evidence, not a valid accepted domain entry.
  const amount = Number.MAX_SAFE_INTEGER;
  const entry = { id: 'query-boundary', householdId: 'home', version: 1, lifecycle: 'effective', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', intent: { kind: 'expense', date: '2026-01-01', description: 'Compressed aggregate', currency: 'JPY', totalMinor: amount }, payers: [{ memberId: 'local-owner', amountMinor: amount }], shares: [{ memberId: 'ledger-b', amountMinor: amount }] };
  await ledgerDB.prepare('PRAGMA ignore_check_constraints=ON').run();
  try {
    await ledgerDB.batch([
      ledgerDB.prepare("INSERT INTO ledger_entries(household_id,id,kind,version,lifecycle,currency,total_minor,created_at,updated_at) VALUES('home','query-boundary','expense',1,'effective','JPY',?,?,?)").bind(amount, entry.createdAt, entry.updatedAt),
      ledgerDB.prepare("INSERT INTO ledger_revisions(household_id,entry_id,version,actor_id,origin,operation_id,action,accepted_at,snapshot_json) VALUES('home','query-boundary',1,'local-owner','app','query-boundary-op','create',?,?)").bind(entry.createdAt, JSON.stringify(entry)),
      ...[['local-owner', amount], ['ledger-b', -amount]].map(([memberId, net]) => ledgerDB.prepare("INSERT INTO ledger_effects(household_id,entry_id,version,effect_kind,member_id,currency,amount_minor) VALUES('home','query-boundary',1,'snapshot',?,'JPY',?)").bind(memberId, net)),
      ledgerDB.prepare("INSERT INTO ledger_allocations(household_id,entry_id,version,side,position,member_id,amount_minor) VALUES('home','query-boundary',1,'payer',0,'local-owner',?),('home','query-boundary',1,'share',0,'ledger-b',?)").bind(amount, amount),
      ledgerDB.prepare("UPDATE ledger_financial_revisions SET revision=revision+1 WHERE household_id='home'"),
    ]);
  } finally { await ledgerDB.prepare('PRAGMA ignore_check_constraints=OFF').run(); }
  expect((await queries().balances(context('read'), { currency: 'JPY' })).totals).toEqual([{ currency: 'JPY', paidMinor: amount, shareMinor: amount, sentMinor: 0, receivedMinor: 0, netMinor: 0 }]);
  expect((await queries().repayments(context('read'), { currency: 'JPY' })).items).toEqual([{ currency: 'JPY', senderId: 'ledger-b', receiverId: 'local-owner', amountMinor: amount }]);
  const statement = await queries().export(context('read'), { memberId: 'ledger-b', currency: 'JPY', format: 'csv' });
  expect(statement).toMatchObject({ openingMinor: 0, movementMinor: -amount, closingMinor: -amount });
  expect(statement.csv).toContain('"-9007199254740991","-9007199254740991"');
});

it('keeps a completed first-page snapshot reconciling if a correction commits before disclosure', async () => {
  const a = await commands().createExpense(context('after-snapshot-a'), bill(100, { currency: 'GBP', date: '2028-01-01' }));
  await commands().createExpense(context('after-snapshot-b'), bill(100, { currency: 'GBP', date: '2028-01-02' }));
  const scope = { memberId: 'local-owner', currency: 'GBP' as const, from: '2028-01-01', to: '2028-01-31', limit: 1 };
  const before = await queries().statement(context('read'), scope);
  let batches = 0;
  const db = new Proxy(ledgerDB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      batches++;
      const rows = await target.batch(statements);
      await commands().correctExpense(context('after-snapshot-correct', 1), a.id, bill(200, { currency: 'GBP', date: '2028-01-01' }));
      return rows;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const page = await queries(db).statement(context('read'), scope);
  expect(batches).toBe(1);
  expect(page).toEqual(before);
  expect(page).toMatchObject({ openingMinor: 0, movementMinor: 100, closingMinor: 100 });
  await expect(queries().statement(context('read'), { ...scope, cursor: page.nextCursor! })).rejects.toMatchObject({ status: 409, code: 'ledger_revision_changed' });
});
