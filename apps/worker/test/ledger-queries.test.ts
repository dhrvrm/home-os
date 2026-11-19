import { beforeEach, expect, it } from 'vitest';
import { LedgerQueries } from '../src/ledger/queries';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import { bill, ledgerDB, ledgerFixture } from './ledger-fixtures';

let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const queries = () => new LedgerQueries(new D1LedgerQueryRepository(ledgerDB), 'query-test-secret');
const commands = () => new LedgerService(new D1LedgerRepository(ledgerDB));

it('aggregates complete balances and summaries beyond the visible entry page', async () => {
  for (let i = 0; i < 27; i++) await commands().createExpense(context(`many-${i}`), bill(100, { category: i % 2 ? 'Food' : 'Home' }));
  const entries = await queries().entries(context('read'), { limit: 2 });
  expect(entries.items).toHaveLength(2);
  expect(entries.totals).toEqual([{ currency: 'INR', expenseMinor: 2700, creditMinor: 0, paymentMinor: 0, netSpendingMinor: 2700, count: 27 }]);
  const balances = await queries().balances(context('read'), { limit: 1 });
  expect(balances.totals[0]).toMatchObject({ currency: 'INR', netMinor: 0, paidMinor: 2700, shareMinor: 2700 });
  const all = [...balances.items];
  let cursor = balances.nextCursor;
  while (cursor) { const page = await queries().balances(context('read'), { limit: 1, cursor }); all.push(...page.items); cursor = page.nextCursor; }
  expect(all.find(row => row.memberId === 'local-owner')).toMatchObject({ netMinor: 1350, paidMinor: 2700, shareMinor: 1350 });
  expect(all.find(row => row.memberId === 'ledger-b')).toMatchObject({ netMinor: -1350 });
  const suggestions = await queries().repayments(context('read'), {});
  expect(suggestions.items).toEqual([{ currency: 'INR', senderId: 'ledger-b', receiverId: 'local-owner', amountMinor: 1350 }]);
  const summary = await queries().summaries(context('read'), { groupBy: 'category', limit: 1 });
  expect(summary.items).toHaveLength(1);
  expect(summary.totals[0]).toMatchObject({ expenseMinor: 2700, netSpendingMinor: 2700 });
});

it('binds search/date/category/member/currency/lifecycle filters to retained current facts', async () => {
  const a = await commands().createExpense(context('filters'), bill(120, { description: '50% dinner', category: 'Food' }));
  expect((await queries().entries(context('read'), { search: '%', category: 'Food', memberId: 'ledger-b', currency: 'INR', from: '2026-11-19', to: '2026-11-19' })).items.map(e => e.id)).toEqual([a.id]);
  expect((await queries().entries(context('read'), { search: "' OR 1=1 --" })).items).toEqual([]);
  await commands().voidEntry(context('void-filter', 1), a.id);
  expect((await queries().entries(context('read'), {})).items.map(e => e.id)).not.toContain(a.id);
  expect((await queries().entries(context('read'), { lifecycle: 'void' })).items.map(e => e.id)).toEqual([a.id]);
  expect((await queries().getEntry(context('read'), a.id)).entry.lifecycle).toBe('void');
  expect((await queries().history(context('read'), a.id, { limit: 1 })).items[0]).toMatchObject({ action: 'create', transitions: [{ effectKind: 'replacement' }, { effectKind: 'replacement' }] });
});

it('returns narrow actor-owned operation references and honest Unknown', async () => {
  const a = await commands().createExpense(context('my-op'), bill());
  expect(await queries().operationStatus(context('read'), 'my-op')).toEqual({ status: 'accepted', entryId: a.id, version: 1, action: 'create' });
  expect(await queries().operationStatus(context('read'), 'absent')).toEqual({ status: 'unknown' });
  const { digest } = await import('../src/auth/crypto');
  const hash = await digest('query-other-session');
  await ledgerDB.batch([
    ledgerDB.prepare("INSERT OR IGNORE INTO auth_accounts(member_id,email,password_hash,updated_at) VALUES('ledger-b','query-other@test.test','fixture',CURRENT_TIMESTAMP)"),
    ledgerDB.prepare("INSERT INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES(?,'ledger-b',1,'2099-01-01T00:00:00Z',CURRENT_TIMESTAMP)").bind(hash),
  ]);
  const other = context('read');
  other.actorId = 'ledger-b';
  other.authority = { householdId: 'home', memberId: 'ledger-b', role: 'member', proof: { kind: 'browser', tokenHash: hash, credentialVersion: 1 } };
  expect(await queries().operationStatus(other, 'my-op')).toEqual({ status: 'unknown' });
});

it('conserves expense, linked-credit and reported-payment signs and deterministically settles every net', async () => {
  const original = await commands().createExpense(context('signed-expense'), bill(300, { currency: 'EUR', category: 'Food', allocation: { kind: 'split', split: { mode: 'equal', participants: ['local-owner', 'ledger-b', 'ledger-c'].map(memberId => ({ memberId, kind: 'equal' })) } } }));
  await commands().createRefund(context('signed-refund'), { kind: 'refund', expenseId: original.id, date: '2026-11-20', description: 'Returned', currency: 'EUR', totalMinor: 60, payers: [{ memberId: 'local-owner', amountMinor: 60 }], shares: [{ memberId: 'ledger-b', amountMinor: 30 }, { memberId: 'ledger-c', amountMinor: 30 }] });
  await commands().createPayment(context('signed-payment'), { kind: 'payment', date: '2026-11-21', currency: 'EUR', totalMinor: 50, senderId: 'ledger-b', receiverId: 'ledger-c', method: 'Cash' });
  expect((await queries().getEntry(context('read'), original.id)).refundCapacity).toEqual({ expenseId: original.id, available: true, totalMinor: 300, creditedMinor: 60, remainingMinor: 240, payers: [{ memberId: 'local-owner', originalMinor: 300, creditedMinor: 60, remainingMinor: 240 }], shares: [{ memberId: 'local-owner', originalMinor: 100, creditedMinor: 0, remainingMinor: 100 }, { memberId: 'ledger-b', originalMinor: 100, creditedMinor: 30, remainingMinor: 70 }, { memberId: 'ledger-c', originalMinor: 100, creditedMinor: 30, remainingMinor: 70 }] });
  await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-c'").run();
  const balances = await queries().balances(context('read'), { currency: 'EUR' });
  expect(balances.items).toEqual([
    { memberId: 'ledger-b', currency: 'EUR', paidMinor: 0, shareMinor: 70, sentMinor: 50, receivedMinor: 0, netMinor: -20, displayName: 'B', active: true },
    { memberId: 'ledger-c', currency: 'EUR', paidMinor: 0, shareMinor: 70, sentMinor: 0, receivedMinor: 50, netMinor: -120, displayName: 'C', active: false },
    { memberId: 'local-owner', currency: 'EUR', paidMinor: 240, shareMinor: 100, sentMinor: 0, receivedMinor: 0, netMinor: 140, displayName: 'Home owner', active: true },
  ]);
  expect(balances.totals).toEqual([{ currency: 'EUR', paidMinor: 240, shareMinor: 240, sentMinor: 50, receivedMinor: 50, netMinor: 0 }]);
  const first = await queries().repayments(context('read'), { currency: 'EUR', limit: 1 });
  const second = await queries().repayments(context('read'), { currency: 'EUR', limit: 1, cursor: first.nextCursor! });
  expect([...first.items, ...second.items]).toEqual([{ currency: 'EUR', senderId: 'ledger-b', receiverId: 'local-owner', amountMinor: 20 }, { currency: 'EUR', senderId: 'ledger-c', receiverId: 'local-owner', amountMinor: 120 }]);
  expect(second.nextCursor).toBeNull();
  const summaries = await queries().summaries(context('read'), { currency: 'EUR', groupBy: 'category', category: 'Food' });
  expect(summaries.items).toEqual([{ currency: 'EUR', group: 'Food', expenseMinor: 300, creditMinor: 60, netSpendingMinor: 240, paymentMinor: 0, count: 2 }]);
  expect(await queries().statement(context('read'), { memberId: 'ledger-b', currency: 'EUR' })).toMatchObject({ openingMinor: 0, movementMinor: -20, closingMinor: -20, movementCount: 3 });
});

it('bounds comments/history on retained voided entries and keeps comment cursors useful after financial changes', async () => {
  const entry = await commands().createExpense(context('comment-subject'), bill(100, { currency: 'GBP' }));
  // Fixed accepted-time comments exercise deterministic append pagination; the fourth uses actual U3 acceptance.
  const add = (n: number) => ledgerDB.prepare("INSERT INTO ledger_comments(household_id,id,entry_id,observed_version,author_id,operation_id,text,accepted_at) VALUES('home',?,?,1,'local-owner',?,?,?)").bind(`query-comment-${n}`, entry.id, `query-comment-op-${n}`, `Comment ${n}`, `2026-11-19T12:00:0${n}.000Z`).run();
  await add(1); await add(2); await add(3);
  const before = await queries().comments(context('read'), entry.id, { limit: 2 });
  expect(before.items.map(c => c.text)).toEqual(['Comment 1', 'Comment 2']);
  expect(before.items[0]).toMatchObject({ authorId: 'local-owner', observedVersion: 1 });
  await commands().voidEntry(context('comment-void', 1), entry.id);
  const fourth = await commands().addComment(context('actual-comment-op', 2), entry.id, 'Comment 4');
  const after = await queries().comments(context('read'), entry.id, { limit: 2, cursor: before.nextCursor! });
  expect(after.items.map(c => c.text)).toEqual(['Comment 3', 'Comment 4']);
  expect(after.nextCursor).toBeNull();
  const history = await queries().history(context('read'), entry.id, { limit: 1 });
  const history2 = await queries().history(context('read'), entry.id, { limit: 1, cursor: history.nextCursor! });
  expect(history2.items[0]).toMatchObject({ action: 'void', version: 2, snapshot: { lifecycle: 'void' } });
  expect(await queries().operationStatus(context('read'), 'actual-comment-op')).toEqual({ status: 'accepted', entryId: entry.id, version: 2, action: 'comment', commentId: fourth.id });
});

it('matches cumulative intervals across multiple debtors and creditors in stable member order', async () => {
  await ledgerDB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES('query-d','home','D','viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").run();
  const expense = (payer: string, beneficiary: string, amount: number) => bill(amount, { currency: 'USD', payers: [{ memberId: payer, amountMinor: amount }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: beneficiary, kind: 'equal' }] } } });
  await commands().createExpense(context('interval-a'), expense('ledger-c', 'ledger-b', 100));
  await commands().createExpense(context('interval-b'), expense('ledger-c', 'query-d', 50));
  await commands().createExpense(context('interval-c'), expense('local-owner', 'query-d', 100));
  const all = [];
  let cursor: string | undefined;
  do {
    const page = await queries().repayments(context('read'), { currency: 'USD', limit: 1, ...(cursor ? { cursor } : {}) });
    all.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(all).toEqual([{ currency: 'USD', senderId: 'ledger-b', receiverId: 'ledger-c', amountMinor: 100 }, { currency: 'USD', senderId: 'query-d', receiverId: 'ledger-c', amountMinor: 50 }, { currency: 'USD', senderId: 'query-d', receiverId: 'local-owner', amountMinor: 100 }]);
});
