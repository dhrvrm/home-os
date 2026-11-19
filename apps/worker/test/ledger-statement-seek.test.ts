import { expect, it } from 'vitest';
import { D1LedgerQueryRepository } from '../src/ledger/d1-query-repository';
import { ledgerDB, ledgerFixture } from './ledger-fixtures';
import { measuredStatementDB } from './ledger-statement-measurement';

it('uses indexed date/key ranges and point head/effect joins without sorting', async () => {
  const context = await ledgerFixture();
  const measured = measuredStatementDB(ledgerDB);
  await new D1LedgerQueryRepository(measured.database).read(context('seek-plan'), {
    kind: 'statement', filter: { memberId: 'local-owner', currency: 'INR' }, limit: 50, offset: 0,
    statement: { revision: 0, after: ['2026-11-19', 'seek-00049'], runningMinor: 50,
      totals: { openingMinor: 0, movementMinor: 100, closingMinor: 100, movementCount: 100 } },
  }, 'ledger_statements');
  const ranges = measured.records.filter(row => row.sql.includes('INDEXED BY ledger_revisions_statement_order'));
  expect(ranges).toHaveLength(2);
  for (const [i, query] of ranges.entries()) {
    const plan = await ledgerDB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail);
    console.info(JSON.stringify({ scenario: i ? 'later-date-seek-plan' : 'same-date-seek-plan', details }));
    expect(details[0]).toMatch(/SEARCH basis .*household_id=\?/);
    expect(details.some(row => row.includes('ledger_revisions_statement_order') && row.includes(i ? '<expr>>?' : 'entry_id>?'))).toBe(true);
    expect(details.some(row => /SEARCH h .*[( ]id=\?/.test(row))).toBe(true);
    expect(details.some(row => /SEARCH e .*entry_id=\?/.test(row))).toBe(true);
    expect(details.join('\n')).not.toMatch(/SCAN |TEMP B-TREE|MATERIALIZE|CO-ROUTINE/);
  }
});
