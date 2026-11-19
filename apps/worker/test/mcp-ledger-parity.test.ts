import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { overriddenFetch, browserProof, personalOAuth, mcpRequest, realFetch, resetOAuthFixtures, measuredFetch, browserRequest, data } from './oauth-fixtures';
import { beforeBatch, bill } from './ledger-fixtures';
async function rpc(response: Response) {
  const body = await response.text();
  return JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body);
}
async function call(token: string, name: string, args: unknown, fetch = realFetch) { return (await rpc(await fetch(mcpRequest(token, 'tools/call', { name, arguments: args })))).result; }
beforeEach(resetOAuthFixtures);
it('admits actual personal OAuth financial writes with exact API reads, replay and provenance', async () => {
  const oauth = await personalOAuth('member', 'ledger-connected');
  const input = bill(101, { payers: [{ memberId: oauth.browser.memberId, amountMinor: 101 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: oauth.browser.memberId, kind: 'equal' }, { memberId: 'local-owner', kind: 'equal' }] } } });
  const preview = await call(oauth.tokens.access_token, 'ledger_preview', input);
  expect(preview).toMatchObject({ structuredContent: { allocation: { totalMinor: 101 } } });
  const created = await call(oauth.tokens.access_token, 'ledger_expense_create', { operationId: 'connected-bill', entry: input });
  expect(created).toMatchObject({ structuredContent: { status: 'accepted', entry: { version: 1, shares: preview.structuredContent.allocation.shares } } });
  const entry = created.structuredContent.entry;
  expect(await data(await realFetch(browserRequest(oauth.browser, `/api/v1/ledger/entries/${entry.id}`)))).toMatchObject({ entry });
  expect(await call(oauth.tokens.access_token, 'ledger_expense_create', { operationId: 'connected-bill', entry: input })).toMatchObject({ structuredContent: { entry } });
  expect(await call(oauth.tokens.access_token, 'ledger_operation_status', { operationId: 'connected-bill' })).toMatchObject({ structuredContent: { status: 'accepted', entryId: entry.id, version: 1 } });
  const history = await call(oauth.tokens.access_token, 'ledger_history_list', { entryId: entry.id });
  expect(history.structuredContent.items[0]).toMatchObject({ actorId: oauth.browser.memberId, origin: 'mcp', operationId: 'connected-bill' });
  const audit = await call(oauth.tokens.access_token, 'activity_list', { entityId: entry.id });
  expect(audit.structuredContent.events[0]).toMatchObject({ actorId: oauth.browser.memberId, mcpTool: 'ledger_expense_create', mcpClientId: oauth.client.client_id, operationId: 'connected-bill' });
});

const ledgerReads = ['ledger_entries_list','ledger_entry_get','ledger_preview','ledger_comments_list','ledger_history_list','ledger_balances','ledger_repayments','ledger_summaries','ledger_statement','ledger_export','ledger_operation_status'];
const ledgerWrites = ['ledger_expense_create','ledger_refund_create','ledger_payment_create','ledger_entry_correct','ledger_entry_void','ledger_entry_restore','ledger_comment_add','ledger_rule_post'];
for (const ceiling of ['owner','member','viewer'] as const) for (const role of ['owner','member','viewer'] as const) it(`discovers the exact ledger primitives for current ${role} and approved ${ceiling}`, async () => {
  await browserProof('owner', 'local-owner');
  const oauth = await personalOAuth(ceiling, 'ledger-matrix');
  await env.DB.prepare('UPDATE members SET role=? WHERE id=?').bind(role, oauth.browser.memberId).run();
  const listed = (await rpc(await realFetch(mcpRequest(oauth.tokens.access_token)))).result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
  const permitted = role !== 'viewer' && ceiling !== 'viewer';
  expect(listed.filter(t => t.name.startsWith('ledger_')).map(t => t.name).sort()).toEqual([...ledgerReads, ...(permitted ? ledgerWrites : [])].sort());
  expect(listed.filter(t => ledgerReads.includes(t.name)).every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true);
  if (permitted) {
    expect(listed.find(t => t.name === 'ledger_entry_correct')?.annotations.destructiveHint).toBe(true);
    expect(listed.find(t => t.name === 'ledger_entry_void')?.annotations.destructiveHint).toBe(true);
    expect(listed.find(t => t.name === 'ledger_entry_restore')?.annotations.destructiveHint).toBe(false);
  } else {
    const refused = await rpc(await realFetch(mcpRequest(oauth.tokens.access_token, 'tools/call', { name: 'ledger_payment_create', arguments: { operationId: 'matrix-write' } })));
    expect(refused.error || refused.result?.isError).toBeTruthy();
  }
});
it('enforces raw MCP framing limits before parsing escaped or multibyte bodies, preserving OAuth admission', async () => {
  const oauth = await personalOAuth('viewer', 'ledger-body-reader');
  const original = mcpRequest(oauth.tokens.access_token);
  for (const raw of [' '.repeat(65537), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', extra: '界'.repeat(23000) })]) {
    const measured = measuredFetch();
    const response = await measured.fetch(new Request(original, { body: raw }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { data: { code: 'payload_too_large' } } });
    expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  }
  const headers = new Headers(original.headers); headers.set('authorization', 'Bearer test-mcp-token');
  expect((await realFetch(new Request(original, { headers, body: ' '.repeat(65537) }))).status).toBe(401);
});
it('refuses forged fields and malicious expression input without accepting any fact', async () => {
  const oauth = await personalOAuth('member', 'ledger-forgery');
  const input = bill(100, { payers: [{ memberId: oauth.browser.memberId, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: oauth.browser.memberId, kind: 'equal' }] } } });
  for (const extra of [{ actorId: 'local-owner' }, { householdId: 'foreign' }, { authorId: 'local-owner' }, { role: 'owner' }, { expression: 'globalThis.fetch(secret)' }]) {
    const output = await rpc(await realFetch(mcpRequest(oauth.tokens.access_token, 'tools/call', { name: 'ledger_expense_create', arguments: { operationId: 'forged-ledger', entry: input, ...extra } })));
    expect(output.error || output.result?.isError).toBeTruthy();
  }
  const result = await rpc(await realFetch(mcpRequest(oauth.tokens.access_token, 'tools/call', { name: 'ledger_preview', arguments: { ...input, totalMinor: '1+eval(99)' } })));
  expect(result.error || result.result?.isError).toBeTruthy();
  expect(await call(oauth.tokens.access_token, 'ledger_operation_status', { operationId: 'forged-ledger' })).toMatchObject({ structuredContent: { status: 'unknown' } });
});

it('shares all financial lifecycle actions, comments, current conflicts and every query through HTTP and OAuth', async () => {
  const oauth = await personalOAuth('member', 'ledger-all-actions'), token = oauth.tokens.access_token, person = oauth.browser.memberId;
  const input = bill(900, { payers: [{ memberId: person, amountMinor: 900 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }, { memberId: 'local-owner', kind: 'equal' }] } } });
  const http = async (path: string, body: unknown, operationId: string, version?: number, method = 'POST') => {
    const request = browserRequest(oauth.browser, `/api/v1/ledger${path}`, body, { 'X-Operation-ID': operationId, ...(version ? { 'If-Match': String(version) } : {}) });
    return data<any>(await realFetch(new Request(request, { method })));
  };
  const entry = (await http('/expenses', input, 'actions-http-create')).entry;
  const corrected = await call(token, 'ledger_entry_correct', { operationId: 'actions-correct', entryId: entry.id, expectedVersion: 1, entry: { ...input, description: 'Corrected' } });
  expect(corrected).toMatchObject({ structuredContent: { entry: { version: 2, intent: { description: 'Corrected' } } } });
  const stale = { operationId: 'actions-stale', entryId: entry.id, expectedVersion: 1, entry: input };
  expect(await call(token, 'ledger_entry_correct', stale)).toMatchObject({ isError: true, structuredContent: { status: 'conflict', actualVersion: 2 } });
  expect((await realFetch(new Request(browserRequest(oauth.browser, `/api/v1/ledger/entries/${entry.id}`, input, { 'X-Operation-ID': 'http-stale', 'If-Match': '1' }), { method: 'PUT' }))).status).toBe(409);
  const refund = { kind: 'refund', expenseId: entry.id, date: input.date, description: 'Returned', currency: 'INR', totalMinor: 100, payers: [{ memberId: person, amountMinor: 100 }], shares: [{ memberId: 'local-owner', amountMinor: 100 }] };
  const credit = (await call(token, 'ledger_refund_create', { operationId: 'actions-refund', entry: refund })).structuredContent.entry;
  expect(credit.intent.totalMinor).toBe(100);
  expect((await http(`/entries/${credit.id}`, { ...refund, description: 'Refund corrected' }, 'refund-correct', 1, 'PUT')).entry.version).toBe(2);
  expect((await call(token, 'ledger_entry_void', { operationId: 'refund-void', entryId: credit.id, expectedVersion: 2 })).structuredContent.entry.lifecycle).toBe('void');
  expect((await http(`/entries/${credit.id}/restore`, {}, 'refund-restore', 3)).entry.version).toBe(4);
  const payment = { kind: 'payment', date: input.date, currency: 'INR', totalMinor: 50, senderId: 'local-owner', receiverId: person, method: 'cash' };
  const paid = (await call(token, 'ledger_payment_create', { operationId: 'actions-payment', entry: payment })).structuredContent.entry;
  expect((await call(token, 'ledger_entry_correct', { operationId: 'payment-correct', entryId: paid.id, expectedVersion: 1, entry: { ...payment, totalMinor: 70 } })).structuredContent.entry.version).toBe(2);
  expect((await http(`/entries/${paid.id}/void`, {}, 'payment-void', 2)).entry.lifecycle).toBe('void');
  expect((await call(token, 'ledger_entry_restore', { operationId: 'payment-restore', entryId: paid.id, expectedVersion: 3 })).structuredContent.entry.version).toBe(4);
  const comment = await call(token, 'ledger_comment_add', { operationId: 'actions-comment', entryId: entry.id, expectedVersion: 2, text: 'Explained' });
  expect(comment).toMatchObject({ structuredContent: { comment: { authorId: person, text: 'Explained', observedVersion: 2 } } });
  expect((await http(`/entries/${entry.id}/comments`, { text: 'HTTP explanation' }, 'http-comment', 2)).comment.authorId).toBe(person);
  for (const [tool, path, args] of [
    ['ledger_entries_list', '/entries', {}], ['ledger_entry_get', `/entries/${entry.id}`, { entryId: entry.id }],
    ['ledger_comments_list', `/entries/${entry.id}/comments`, { entryId: entry.id }], ['ledger_history_list', `/entries/${entry.id}/history`, { entryId: entry.id }],
    ['ledger_balances', '/balances', {}], ['ledger_repayments', '/repayments', {}], ['ledger_summaries', '/summaries?groupBy=category', { groupBy: 'category' }],
    ['ledger_statement', `/statements?memberId=${person}&currency=INR`, { memberId: person, currency: 'INR' }],
    ['ledger_export', `/export?memberId=${person}&currency=INR&format=csv`, { memberId: person, currency: 'INR', format: 'csv' }],
    ['ledger_operation_status', '/operations/actions-comment', { operationId: 'actions-comment' }],
  ] as const) {
    const connected = await call(token, tool, args);
    expect(connected.isError).not.toBe(true);
    expect(connected.structuredContent).toEqual(await data(await realFetch(browserRequest(oauth.browser, `/api/v1/ledger${path}`))));
  }
  const balance = await call(token, 'ledger_balances', { currency: 'INR', memberId: person });
  expect(balance.structuredContent.items[0]).toMatchObject({ netMinor: 280 });
});
it('previews normalized recurring periods read-only for viewers and posts explicitly through either transport', async () => {
  const oauth = await personalOAuth('member', 'ledger-rule-poster'), token = oauth.tokens.access_token;
  const rule = (await call(token, 'expenses_create', { operationId: 'recurring-catalog', name: 'Monthly', amountMinor: 101, cadence: { unit: 'month', interval: 1, anchorDate: '2026-01-31' }, participants: [{ memberId: oauth.browser.memberId }] })).structuredContent.rule;
  const viewer = await personalOAuth('viewer', 'ledger-rule-reader');
  const previewInput = { kind: 'rule-posting', ruleId: rule.id, expectedRuleVersion: 1, period: 1 };
  const preview = await call(viewer.tokens.access_token, 'ledger_preview', previewInput);
  expect(preview.isError).not.toBe(true);
  expect(preview.structuredContent).toEqual(await data(await realFetch(browserRequest(viewer.browser, '/api/v1/ledger/preview', previewInput))));
  expect(JSON.stringify(preview.structuredContent.source)).toContain('2026-02-28');
  expect(JSON.stringify(preview.structuredContent.source)).toContain('2026-03-31');
  const posting = { ruleId: rule.id, expectedRuleVersion: 1, period: 1, date: '2026-03-05', payers: [{ memberId: oauth.browser.memberId, amountMinor: 101 }] };
  const created = await call(token, 'ledger_rule_post', { operationId: 'explicit-rule-post', ...posting });
  expect(created).toMatchObject({ structuredContent: { status: 'accepted', entry: { intent: { date: '2026-03-05', totalMinor: 101 } } } });
  const duplicate = await realFetch(browserRequest(oauth.browser, '/api/v1/ledger/rule-postings', posting, { 'X-Operation-ID': 'duplicate-rule-http' }));
  expect(duplicate.status).toBe(409);
  const next = await realFetch(browserRequest(oauth.browser, '/api/v1/ledger/rule-postings', { ...posting, period: 2 }, { 'X-Operation-ID': 'next-rule-http' }));
  expect(next.status).toBe(201);
});
it('measures maximum 40-line/12-party success, refusal, reads and authorized replay within fifty combined calls', async () => {
  const oauth = await personalOAuth('member', 'ledger-budget'), token = oauth.tokens.access_token;
  const people = [oauth.browser.memberId, 'local-owner', ...Array.from({ length: 10 }, (_, i) => `ledger-budget-${i}`)];
  await env.DB.batch(people.slice(2).map(id => env.DB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES(?,'home',?,'member',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id,id)));
  const split = { mode: 'equal', participants: people.map(memberId => ({ memberId, kind: 'equal' })) };
  const input = { kind: 'expense', date: '2026-11-19', description: 'Maximum bound', currency: 'INR', totalMinor: 4000, payers: people.map((memberId, i) => ({ memberId, amountMinor: i === 0 ? 4000 : 0 })), allocation: { kind: 'itemized', participantOrder: people, items: Array.from({ length: 40 }, (_, i) => ({ label: `Line ${i}`, quantity: '1', unitPriceMinor: 100, split })) } };
  const observations: Record<string, number> = {};
  const bounded = async (label: string, name: string, args: unknown) => {
    const measured = measuredFetch(), output = await call(token, name, args, measured.fetch);
    observations[label] = measured.requests.d1 + measured.requests.kv;
    expect(observations[label], label).toBeLessThanOrEqual(50);
    return output;
  };
  const args = { operationId: 'maximal-ledger', entry: input };
  const result = await bounded('create', 'ledger_expense_create', args);
  expect(result.isError).not.toBe(true);
  const entryId = result.structuredContent.entry.id;
  expect((await bounded('replay', 'ledger_expense_create', args)).structuredContent.entry.id).toBe(entryId);
  expect((await bounded('changed-intent', 'ledger_expense_create', { ...args, entry: { ...input, description: 'Changed' } })).isError).toBe(true);
  expect((await bounded('stale', 'ledger_entry_correct', { operationId: 'max-stale', entryId, expectedVersion: 9, entry: input })).isError).toBe(true);
  for (const name of ['ledger_entries_list','ledger_balances','ledger_repayments','ledger_summaries']) expect((await bounded(name, name, {})).isError).not.toBe(true);
  for (const name of ['ledger_entry_get','ledger_history_list','ledger_comments_list']) expect((await bounded(name, name, { entryId })).isError).not.toBe(true);
  expect((await bounded('comment', 'ledger_comment_add', { operationId: 'max-comment', entryId, expectedVersion: 1, text: 'Accepted explanation' })).isError).not.toBe(true);
  for (const name of ['ledger_statement','ledger_export']) expect((await bounded(name, name, { memberId: people[0], currency: 'INR' })).isError).not.toBe(true);
  expect((await bounded('correct-maximal', 'ledger_entry_correct', { operationId: 'max-correct', entryId, expectedVersion: 1, entry: { ...input, description: 'Maximum corrected' } })).isError).not.toBe(true);
  expect((await bounded('void-maximal', 'ledger_entry_void', { operationId: 'max-void', entryId, expectedVersion: 2 })).isError).not.toBe(true);
  expect((await bounded('restore-maximal', 'ledger_entry_restore', { operationId: 'max-restore', entryId, expectedVersion: 3 })).isError).not.toBe(true);
  const refund = { kind: 'refund', expenseId: entryId, date: input.date, description: 'Budget refund', currency: 'INR', totalMinor: 1, payers: [{ memberId: people[0], amountMinor: 1 }], shares: [{ memberId: people[0], amountMinor: 1 }] };
  const credit = await bounded('refund-create', 'ledger_refund_create', { operationId: 'max-refund', entry: refund });
  expect(credit.isError).not.toBe(true);
  expect((await bounded('refund-replay', 'ledger_refund_create', { operationId: 'max-refund', entry: refund })).isError).not.toBe(true);
  const payment = { kind: 'payment', date: input.date, currency: 'INR', totalMinor: 1, senderId: people[0], receiverId: people[1], method: 'reported cash' };
  expect((await bounded('payment-create', 'ledger_payment_create', { operationId: 'max-payment', entry: payment })).isError).not.toBe(true);
  expect((await bounded('payment-replay', 'ledger_payment_create', { operationId: 'max-payment', entry: payment })).isError).not.toBe(true);
  const rule = (await call(token, 'expenses_create', { operationId: 'budget-rule', name: 'Budget rule', amountMinor: 100, cadence: { unit: 'month', interval: 1, anchorDate: input.date }, participants: [{ memberId: people[0] }] })).structuredContent.rule;
  const posting = { operationId: 'max-post', ruleId: rule.id, expectedRuleVersion: 1, period: 0, date: input.date, payers: [{ memberId: people[0], amountMinor: 100 }] };
  expect((await bounded('rule-preview', 'ledger_preview', { kind: 'rule-posting', ruleId: rule.id, expectedRuleVersion: 1, period: 0 })).isError).not.toBe(true);
  expect((await bounded('post-create', 'ledger_rule_post', posting)).isError).not.toBe(true);
  expect((await bounded('post-replay', 'ledger_rule_post', posting)).isError).not.toBe(true);
  expect((await bounded('post-duplicate', 'ledger_rule_post', { ...posting, operationId: 'max-post-duplicate' })).isError).toBe(true);
  expect((await bounded('status', 'ledger_operation_status', { operationId: 'max-post' })).isError).not.toBe(true);
  for (const [label, entry] of [['http-success', input], ['http-replay', input], ['http-refusal', { ...input, description: 'Changed HTTP intent' }]] as const) {
    const measured = measuredFetch();
    const response = await measured.fetch(browserRequest(oauth.browser, '/api/v1/ledger/expenses', entry, { 'X-Operation-ID': 'max-http' }));
    expect(response.status).toBe(label === 'http-refusal' ? 409 : 201);
    observations[label] = measured.requests.d1 + measured.requests.kv;
    expect(observations[label], label).toBeLessThanOrEqual(50);
  }
  await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(oauth.browser.memberId).run();
  const refused = measuredFetch();
  expect((await refused.fetch(mcpRequest(token, 'tools/call', { name: 'ledger_expense_create', arguments: args }))).status).toBe(401);
  observations['revoked-replay'] = refused.requests.d1 + refused.requests.kv;
  expect(observations['revoked-replay']).toBeLessThanOrEqual(50);
  console.log('U5 combined D1+KV observations', observations);
});

it('keeps complete month and category summaries beyond the first page identical through both transports', async () => {
  const oauth = await personalOAuth('member', 'ledger-summary-reader'), person = oauth.browser.memberId, token = oauth.tokens.access_token;
  for (let i = 0; i < 27; i++) {
    const date = `${2024 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2,'0')}-01`;
    const entry = bill(100, { description: 'Complete-scope-proof', date, category: `Category ${i}`, payers: [{ memberId: person, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }] } } });
    expect((await call(token, 'ledger_expense_create', { operationId: `summary-record-${i}`, entry })).isError).not.toBe(true);
  }
  for (const groupBy of ['month','category']) {
    let cursor: string | undefined; const seen: string[] = [];
    do {
      const input = { search: 'Complete-scope-proof', groupBy, limit: 10, ...(cursor ? { cursor } : {}) };
      const page = await call(token, 'ledger_summaries', input);
      const params = new URLSearchParams({ ...input, limit: '10' });
      expect(page.structuredContent).toEqual(await data(await realFetch(browserRequest(oauth.browser, `/api/v1/ledger/summaries?${params}`))));
      expect(page.structuredContent.totals).toEqual([{ currency: 'INR', expenseMinor: 2700, creditMinor: 0, paymentMinor: 0, netSpendingMinor: 2700, count: 27 }]);
      seen.push(...page.structuredContent.items.map((row: { group: string }) => row.group));
      cursor = page.structuredContent.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(27);
  }
});
it.each(['revoked','demoted'] as const)('rechecks current %s authority inside financial acceptance through actual OAuth', async mode => {
  const oauth = await personalOAuth('member', 'ledger-accept-race'), person = oauth.browser.memberId;
  const input = bill(100, { payers: [{ memberId: person, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }] } } });
  const database = beforeBatch(env.DB, async () => {
    if (mode === 'revoked') await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(person).run();
    else await env.DB.prepare("UPDATE members SET role='viewer' WHERE id=?").bind(person).run();
  });
  const result = await call(oauth.tokens.access_token, 'ledger_expense_create', { operationId: 'accept-race', entry: input }, overriddenFetch({ DB: database }));
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'refused', code: 'forbidden' } });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ledger_revisions WHERE operation_id='accept-race'").first()).toMatchObject({ count: 0 });
});
it('rechecks continuing personal authority after a financial read snapshot and before disclosure', async () => {
  const oauth = await personalOAuth('member', 'ledger-disclose-race');
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(oauth.browser.memberId).run();
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  expect(await call(oauth.tokens.access_token, 'ledger_balances', {}, overriddenFetch({ DB: database }))).toMatchObject({ isError: true, structuredContent: { status: 'refused', code: 'forbidden' } });
});
it.each(['identical', 'changed'] as const)('does not disclose an accepted replay or %s-intent error after its exact personal grant ends during lookup', async mode => {
  const oauth = await personalOAuth('member', 'ledger-replay-race'), person = oauth.browser.memberId;
  const entry = bill(100, { description: 'Do not disclose this accepted fact', payers: [{ memberId: person, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }] } } });
  const args = { operationId: `replay-race-${mode}`, entry };
  expect((await call(oauth.tokens.access_token, 'ledger_expense_create', args)).isError).not.toBe(true);
  let ended = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
    if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
    if (key === 'first') return async () => {
      const result = await target.first();
      await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(person).run();
      ended = true; return result;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'prepare') return (sql: string) => sql.includes('LEFT JOIN household_command_receipts') ? wrap(target.prepare(sql)) : target.prepare(sql);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const replayArgs = mode === 'identical' ? args : { ...args, entry: { ...entry, description: 'Changed collision intent' } };
  const result = await call(oauth.tokens.access_token, 'ledger_expense_create', replayArgs, overriddenFetch({ DB: database }));
  expect(ended).toBe(true);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'refused' } });
  expect(JSON.stringify(result)).not.toContain(entry.description);
});

it('suppresses mutation disclosure after accepting a fact whose grant immediately ends, retaining exactly one accepted revision', async () => {
  const oauth = await personalOAuth('member', 'ledger-post-accept-race'), person = oauth.browser.memberId;
  const entry = bill(100, { payers: [{ memberId: person, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }] } } });
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(person).run();
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await call(oauth.tokens.access_token, 'ledger_expense_create', { operationId: 'post-accept-race', entry }, overriddenFetch({ DB: database }));
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'refused', code: 'forbidden' } });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ledger_revisions WHERE operation_id='post-accept-race'").first()).toMatchObject({ count: 1 });
});
it('refuses generic browser or retired operator proof at the connected ledger transport', async () => {
  const browser = await browserProof('owner', 'local-owner');
  const sessionOnly = new Request(mcpRequest('test-mcp-token'), { headers: { cookie: browser.cookie, 'content-type': 'application/json' } });
  expect((await realFetch(sessionOnly)).status).toBe(401);
  expect((await realFetch(mcpRequest('test-mcp-token', 'tools/call', { name: 'ledger_balances', arguments: {} }))).status).toBe(401);
});

it('maps malformed raw MCP JSON to its protocol parse error without a server failure', async () => {
  const oauth = await personalOAuth('viewer', 'ledger-invalid-json');
  const response = await realFetch(new Request(mcpRequest(oauth.tokens.access_token), { body: '{' }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
});
