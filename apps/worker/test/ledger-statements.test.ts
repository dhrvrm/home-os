import { beforeEach, expect, it } from 'vitest';
import { LedgerQueries } from '../src/ledger/queries';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
import { measuredStatementDB } from './ledger-statement-measurement';
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

it('carries totals and exact running balances through date ties, zero, refund and payment movements', async () => {
  const currency = 'USD', date = '2034-02-01';
  const baseline = await queries().statement(context('carry-baseline'), { memberId: 'local-owner', currency, to: '2033-12-31' });
  const prior = baseline.closingMinor;
  const opening = await commands().createExpense(context('carry-opening'), bill(100, { currency, date: '2034-01-01' }));
  const expense = await commands().createExpense(context('carry-expense'), bill(120, { currency, date }));
  const zero = await commands().createExpense(context('carry-zero'), bill(20, { currency, date,
    allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: 'local-owner', kind: 'equal' }] } } }));
  const refund = await commands().createRefund(context('carry-refund'), { kind: 'refund', expenseId: opening.id, date,
    description: 'Refund', currency, totalMinor: 20, payers: [{ memberId: 'local-owner', amountMinor: 20 }], shares: [{ memberId: 'ledger-b', amountMinor: 20 }] });
  const payment = await commands().createPayment(context('carry-payment'), { kind: 'payment', date: '2034-02-02', currency,
    totalMinor: 30, senderId: 'local-owner', receiverId: 'ledger-b', method: 'Cash' });
  const expected = [{ entryId: expense.id, date, amountMinor: 60 }, { entryId: zero.id, date, amountMinor: 0 },
    { entryId: refund.id, date, amountMinor: -20 }, { entryId: payment.id, date: '2034-02-02', amountMinor: 30 }]
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryId < b.entryId ? -1 : 1);
  const measured = measuredStatementDB(ledgerDB), q = queries(measured.database);
  const input = { memberId: 'local-owner', currency, from: date, to: '2034-02-28', limit: 1 };
  let cursor: string | undefined, running = prior + 50, seen = 0;
  do {
    const start = measured.records.length;
    const page = await q.statement(context('carry-read'), { ...input, ...(cursor ? { cursor } : {}) });
    expect(page).toMatchObject({ openingMinor: prior + 50, movementMinor: 70, closingMinor: prior + 120, movementCount: 4 });
    running += expected[seen]!.amountMinor;
    expect(page.items).toEqual([expect.objectContaining({ ...expected[seen]!, version: 1, runningMinor: running })]);
    if (cursor) expect(measured.records.slice(start).map(row => row.sql).join('\n')).not.toMatch(/SUM\(|COUNT\(|OVER\(|OFFSET|WITH facts/);
    seen++; cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toBe(4); expect(running).toBe(prior + 120);
  const json = await q.export(context('carry-json'), { ...input, limit: 50, format: 'json' });
  const csv = await q.export(context('carry-csv'), { ...input, limit: 50, format: 'csv' });
  expect(csv.items).toEqual(json.items);
  for (const row of json.items) expect(csv.csv).toContain(`"${row.entryId}","${row.version}","${row.date}"`);
  expect(await q.statement(context('carry-empty'), { ...input, from: '2034-02-10', to: '2034-02-11' })).toMatchObject({ openingMinor: prior + 120, movementMinor: 0, closingMinor: prior + 120, movementCount: 0, items: [] });
  expect(await q.statement(context('carry-no-to'), { ...input, to: undefined, limit: 50 })).toMatchObject({ openingMinor: prior + 50, movementMinor: 70, closingMinor: prior + 120 });
  expect(await q.statement(context('carry-no-from'), { ...input, from: undefined, limit: 50 })).toMatchObject({ openingMinor: 0, movementMinor: prior + 120, closingMinor: prior + 120, movementCount: baseline.movementCount + 5 });
  expect(measured.records.every(row => row.rowsWritten === 0)).toBe(true);
});

it('authenticates statement carry values and refuses signed invalid shapes before repository reads', async () => {
  for (let i = 0; i < 3; i++) await commands().createExpense(context(`signed-carry-${i}`), bill(2, { currency: 'EUR', date: '2035-01-01' }));
  const input = { memberId: 'local-owner', currency: 'EUR', from: '2035-01-01', limit: 1 };
  const first = await queries().statement(context('signed-read'), input);
  const [body, signature] = first.nextCursor!.split('.');
  type TestCursor = { offset: number; statement: { after: [string, string]; runningMinor: number; extra?: boolean; totals: { movementMinor: number; closingMinor: number; movementCount: number } } };
  const decode = (value: string) => JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))) as TestCursor;
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const mutations = [
    (value: TestCursor) => { value.statement.totals.movementMinor++; },
    (value: TestCursor) => { value.statement.runningMinor++; },
    (value: TestCursor) => { value.statement.after[1] = 'different-entry'; },
  ];
  for (const mutate of mutations) {
    const payload = decode(body!); mutate(payload);
    const measured = measuredStatementDB(ledgerDB);
    await expect(queries(measured.database).statement(context('signed-read'), { ...input, cursor: `${encode(payload)}.${signature}` })).rejects.toMatchObject({ status: 400 });
    expect(measured.records).toHaveLength(2); // Current authority before and after refusal; no snapshot/rows.
  }
  const original = first.nextCursor!;
  for (const patch of [{ memberId: 'ledger-b' }, { currency: 'USD' }, { from: '2034-01-01' }, { to: '2035-12-31' }, { limit: 2 }]) {
    await expect(queries().statement(context('signed-read'), { ...input, ...patch, cursor: original })).rejects.toMatchObject({ status: 400 });
  }
  await expect(queries().export(context('signed-read'), { ...input, format: 'json', cursor: original })).rejects.toMatchObject({ status: 400 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('query-test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  for (const mutate of [
    (value: TestCursor) => { value.statement.after[0] = '2035-02-30'; },
    (value: TestCursor) => { value.statement.totals.closingMinor++; },
    (value: TestCursor) => { value.statement.runningMinor = Number.MAX_SAFE_INTEGER + 1; },
    (value: TestCursor) => { value.statement.extra = true; },
    (value: TestCursor) => { value.offset = value.statement.totals.movementCount; },
  ]) {
    const payload = decode(body!); mutate(payload); const encoded = encode(payload);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`home-os:ledger-query-cursor:v1\n${encoded}`)));
    const signature = btoa(String.fromCharCode(...signed)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const measured = measuredStatementDB(ledgerDB);
    await expect(queries(measured.database).statement(context('signed-read'), { ...input, cursor: `${encoded}.${signature}` })).rejects.toMatchObject({ status: 400 });
    expect(measured.records).toHaveLength(2);
  }
});

it('gates stale statement row work and rechecks authority on stale and failed reads', async () => {
  for (let i = 0; i < 60; i++) await commands().createExpense(context(`stale-statement-${i}`), bill(2, { currency: 'GBP', date: '2036-01-01' }));
  const input = { memberId: 'local-owner', currency: 'GBP', from: '2036-01-01', limit: 1 };
  const first = await queries().statement(context('stale-read'), input);
  await commands().createExpense(context('stale-statement-next'), bill(2, { currency: 'GBP', date: '2036-01-01' }));
  const measured = measuredStatementDB(ledgerDB);
  await expect(queries(measured.database).statement(context('stale-read'), { ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'ledger_revision_changed' });
  const rows = measured.records.filter(row => row.sql.includes('INDEXED BY ledger_revisions_statement_order'));
  expect(rows).toHaveLength(2);
  expect(rows.reduce((sum, row) => sum + row.rowsRead, 0)).toBeLessThanOrEqual(2);
  expect(measured.records).toHaveLength(5);
  const revoked = beforeBatch(ledgerDB, () => ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'").run());
  await expect(queries(revoked).statement(context('stale-read'), { ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 403 });
  await ledgerFixture();
  const failed = new Proxy(ledgerDB, { get(target, key) {
    if (key === 'batch') return async () => {
      await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='local-owner'").run();
      throw new Error('Simulated read failure');
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  await expect(queries(failed).statement(context('failed-read'), input)).rejects.toMatchObject({ status: 403 });
});
