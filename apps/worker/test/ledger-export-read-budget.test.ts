import { expect, it } from 'vitest';
import { LedgerQueries } from '../src/ledger/queries';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import type { Currency } from '../src/ledger/model';
import { bill, ledgerDB, ledgerFixture } from './ledger-fixtures';
import { measuredStatementDB } from './ledger-statement-measurement';

async function seed(count: number, currency: Currency, date: string) {
  const now = '2026-11-19T00:00:00.000Z', prefix = `export-budget-${currency}-`;
  const snapshot = { id: 'fixture', householdId: 'home', version: 1, lifecycle: 'effective', intent: bill(2, { currency, date }), payers: [{ memberId: 'local-owner', amountMinor: 2 }], shares: [{ memberId: 'local-owner', amountMinor: 1 }, { memberId: 'ledger-b', amountMinor: 1 }], createdAt: now, updatedAt: now };
  // Ordinary conserving snapshots isolate query cost from acceptance throughput.
  // Both immutable transition and current snapshot effects are represented.
  await ledgerDB.batch([
    ledgerDB.prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO ledger_entries(household_id,id,kind,version,lifecycle,currency,total_minor,created_at,updated_at) SELECT 'home',?||printf('%05d',i),'expense',1,'effective',?,2,?,? FROM n`).bind(count - 1, prefix, currency, now, now),
    ledgerDB.prepare(`INSERT INTO ledger_revisions(household_id,entry_id,version,actor_id,origin,operation_id,action,accepted_at,snapshot_json) SELECT household_id,id,1,'local-owner','api','op-'||id,'create',?,json_set(?,'$.id',id) FROM ledger_entries WHERE substr(id,1,?)=?`).bind(now, JSON.stringify(snapshot), prefix.length, prefix),
    ...['snapshot', 'replacement'].map(kind => ledgerDB.prepare(`INSERT INTO ledger_effects(household_id,entry_id,version,effect_kind,member_id,currency,amount_minor) SELECT household_id,id,1,?,'local-owner',?,1 FROM ledger_entries WHERE substr(id,1,?)=? UNION ALL SELECT household_id,id,1,?,'ledger-b',?,-1 FROM ledger_entries WHERE substr(id,1,?)=?`).bind(kind, currency, prefix.length, prefix, kind, currency, prefix.length, prefix)),
    ledgerDB.prepare(`INSERT INTO ledger_allocations(household_id,entry_id,version,side,position,member_id,amount_minor) SELECT household_id,id,1,'payer',0,'local-owner',2 FROM ledger_entries WHERE substr(id,1,?)=? UNION ALL SELECT household_id,id,1,'share',0,'local-owner',1 FROM ledger_entries WHERE substr(id,1,?)=? UNION ALL SELECT household_id,id,1,'share',1,'ledger-b',1 FROM ledger_entries WHERE substr(id,1,?)=?`).bind(prefix.length, prefix, prefix.length, prefix, prefix.length, prefix),
    ledgerDB.prepare(`INSERT INTO ledger_financial_revisions(household_id,revision) VALUES('home',?) ON CONFLICT(household_id) DO UPDATE SET revision=revision+excluded.revision`).bind(count),
  ]);
  return Array.from({ length: count }, (_, i) => ({ entryId: `${prefix}${String(i).padStart(5, '0')}`, date, version: 1, amountMinor: 1 }));
}

it('exports 1k/10k and corrected history with linear measured D1 reads including authority', async () => {
  const context = await ledgerFixture();
  const measurements: number[] = [];
  for (const [count, currency, date, history] of [[1000, 'USD', '2030-01-01', false], [10000, 'INR', '2030-01-01', false], [1000, 'EUR', '2030-01-01', true]] as const) {
    let expected = await seed(count, currency, date);
    if (history) {
      const service = new LedgerService(new D1LedgerRepository(ledgerDB));
      for (const [i, row] of expected.entries()) {
        if (i % 10 === 0) {
          await service.correctExpense(context(`history-correct-${i}`, 1), row.entryId, bill(2, { currency, date: '2029-12-31' }));
          row.date = '2029-12-31'; row.version = 2;
        } else if (i % 10 === 1 || i % 10 === 2) {
          await service.voidEntry(context(`history-void-${i}`, 1), row.entryId);
          row.version = 2;
          if (i % 10 === 2) { await service.restoreEntry(context(`history-restore-${i}`, 2), row.entryId); row.version = 3; }
        }
      }
      expected = expected.filter(row => Number(row.entryId.slice(-5)) % 10 !== 1).sort((a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId));
    }
    const revision = (await ledgerDB.prepare("SELECT revision FROM ledger_financial_revisions WHERE household_id='home'").first<{ revision: number }>())!.revision;
    const measured = measuredStatementDB(ledgerDB), queries = new LedgerQueries(new D1LedgerQueryRepository(measured.database), 'export-read-budget-secret');
    const pageReads: number[] = []; let cursor: string | undefined, seen = 0;
    do {
      const beforeRead = measured.rowsRead(), start = measured.records.length;
      const page = await queries.export(context('read-budget'), { memberId: 'local-owner', currency, format: 'json', limit: 50, ...(cursor ? { cursor } : {}) });
      pageReads.push(measured.rowsRead() - beforeRead);
      expect(page).toMatchObject({ revision, openingMinor: 0, movementMinor: expected.length, closingMinor: expected.length, movementCount: expected.length, requiresNarrowerRange: false });
      for (const row of page.items) { expect(row).toMatchObject(expected[seen]!); expect(row.runningMinor).toBe(++seen); }
      if (cursor) expect(measured.records.slice(start).map(row => row.sql).join('\n')).not.toMatch(/SUM\(|COUNT\(|OVER\(|OFFSET|WITH facts/);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toBe(expected.length); expect(pageReads).toHaveLength(Math.ceil(expected.length / 50));
    expect(measured.records.every(row => row.rowsWritten === 0)).toBe(true);
    const continuations = pageReads.slice(1).sort((a, b) => a - b), rowsRead = measured.rowsRead();
    const report = { scenario: `${count}-movement-export${history ? '-corrected-voided-restored-history' : ''}`, pages: pageReads.length, rowsRead, firstPageReads: pageReads[0], continuationTotal: continuations.reduce((sum, value) => sum + value, 0), continuationMedian: continuations[Math.floor(continuations.length / 2)], maxContinuationReads: Math.max(...continuations), lastPageReads: pageReads.at(-1), rowsWritten: 0, measurement: 'actual local D1 result.meta.rows_read, includes pre/batch/post authority; excludes seed writes; not remotely billed reads' }; console.info(JSON.stringify(report));
    expect(rowsRead).toBeLessThan(count === 10000 ? 1_000_000 : 100_000);
    if (!history) measurements.push(rowsRead);
  }
  expect(measurements[1]! / measurements[0]!).toBeGreaterThan(8);
  expect(measurements[1]! / measurements[0]!).toBeLessThan(12);
}, 120_000);

it('reports 10001 movements as requiring narrower scope from complete totals', async () => {
  const context = await ledgerFixture();
  await seed(10001, 'GBP', '2030-01-01');
  const measured = measuredStatementDB(ledgerDB);
  const page = await new LedgerQueries(new D1LedgerQueryRepository(measured.database), 'export-read-budget-secret').export(context('too-many'), { memberId: 'local-owner', currency: 'GBP', format: 'csv', limit: 50 });
  expect(page).toMatchObject({ movementCount: 10001, closingMinor: 10001, requiresNarrowerRange: true, maxMovementRows: 10000 });
  expect(page.items).toHaveLength(50); expect(page.nextCursor).not.toBeNull();
  expect(measured.records.every(row => row.rowsWritten === 0)).toBe(true);
});
