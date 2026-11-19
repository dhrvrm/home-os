import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { beforeBatch, bill } from './ledger-fixtures';
import { browserProof, browserRequest, data, mcpRequest, overriddenFetch, personalOAuth, realFetch, resetOAuthFixtures, type BrowserProof } from './oauth-fixtures';

beforeEach(resetOAuthFixtures);
async function rpc(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text);
}
async function call(token: string, name: string, args: unknown, fetch = realFetch) {
  return (await rpc(await fetch(mcpRequest(token, 'tools/call', { name, arguments: args })))).result;
}
async function createRule(browser: BrowserProof, id: string = crypto.randomUUID()) {
  const response = await realFetch(browserRequest(browser, '/api/v1/expenses', { id, name: 'Current rent', amountMinor: 100, currency: 'INR', cadence: { unit: 'month', interval: 1, anchorDate: '2026-01-01' }, participants: [{ memberId: browser.memberId }] }, { 'X-Operation-ID': crypto.randomUUID() }));
  expect(response.status).toBe(201);
  return (await data<{ rule: { id: string; version: number } }>(response)).rule;
}
const post = (ruleId: string, memberId: string, period = 0) => ({ ruleId, expectedRuleVersion: 1, period, date: '2026-11-20', payers: [{ memberId, amountMinor: 100 }] });
const editAtBatch = (id: string, extra?: () => Promise<unknown>) => overriddenFetch({ DB: beforeBatch(env.DB, async () => {
  await env.DB.prepare("UPDATE expense_rules SET version=version+1,name='Edited during acceptance' WHERE household_id='home' AND id=?").bind(id).run();
  await extra?.();
}) });

it.each(['internet+phone', 'rent 2026', 'rent/2026', 'long retained rule '.repeat(10)])('previews, posts and replays retained catalog ID %s in both transports', async id => {
  const oauth = await personalOAuth('member', 'compat-catalog-id');
  const rule = await createRule(oauth.browser, id), token = oauth.tokens.access_token;
  const preview = { kind: 'rule-posting', ruleId: rule.id, expectedRuleVersion: 1, period: 0 };
  const http = await realFetch(browserRequest(oauth.browser, '/api/v1/ledger/preview', preview));
  expect(http.status).toBe(200);
  expect(await data(http)).toMatchObject({ source: { ruleId: id } });
  expect(await call(token, 'ledger_preview', preview)).toMatchObject({ structuredContent: { source: { ruleId: id } } });
  const input = post(id, oauth.browser.memberId);
  const operationId = crypto.randomUUID();
  const request = () => browserRequest(oauth.browser, '/api/v1/ledger/rule-postings', input, { 'X-Operation-ID': operationId });
  const accepted = await data<{ entry: { id: string } }>(await realFetch(request()));
  expect(await data(await realFetch(request()))).toMatchObject({ entry: accepted.entry });
  const mcpInput = { operationId: crypto.randomUUID(), ...post(id, oauth.browser.memberId, 1) };
  const connected = await call(token, 'ledger_rule_post', mcpInput);
  expect(connected).toMatchObject({ structuredContent: { status: 'accepted', entry: { source: { ruleId: id } } } });
  expect(await call(token, 'ledger_rule_post', mcpInput)).toEqual(connected);
});
it('returns HTTP 409 with the current rule when its version changes at acceptance', async () => {
  const browser = await browserProof('member', 'compat-http-race'), rule = await createRule(browser);
  const response = await editAtBatch(rule.id)(browserRequest(browser, '/api/v1/ledger/rule-postings', post(rule.id, browser.memberId), { 'X-Operation-ID': 'rule-http-race' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'conflict', details: { id: rule.id, version: 2, name: 'Edited during acceptance' } } });
});
it('returns an MCP structured current rule conflict on the same acceptance race', async () => {
  const oauth = await personalOAuth('member', 'compat-mcp-race'), rule = await createRule(oauth.browser);
  const result = await call(oauth.tokens.access_token, 'ledger_rule_post', { operationId: 'rule-mcp-race', ...post(rule.id, oauth.browser.memberId) }, editAtBatch(rule.id));
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'conflict', expectedVersion: 1, actualVersion: 2, current: { id: rule.id, version: 2, name: 'Edited during acceptance' } } });
});
it.each(['browser', 'connection', 'stale-browser', 'demoted-member'])('withholds current rule disclosure after %s authority ends at acceptance', async transport => {
  const oauth = await personalOAuth('member', 'compat-revoked-race'), rule = await createRule(oauth.browser);
  const fetch = editAtBatch(rule.id, () => {
    if (transport === 'browser') return env.DB.prepare('DELETE FROM auth_sessions WHERE public_id=?').bind(oauth.browser.sessionId).run();
    if (transport === 'stale-browser') return env.DB.prepare('UPDATE auth_accounts SET credential_version=credential_version+1 WHERE member_id=?').bind(oauth.browser.memberId).run();
    if (transport === 'demoted-member') return env.DB.prepare("UPDATE members SET role='viewer' WHERE id=?").bind(oauth.browser.memberId).run();
    return env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(oauth.browser.memberId).run();
  });
  const response = transport === 'browser' || transport === 'stale-browser'
    ? await fetch(browserRequest(oauth.browser, '/api/v1/ledger/rule-postings', post(rule.id, oauth.browser.memberId), { 'X-Operation-ID': 'rule-revoked-race' }))
    : await fetch(mcpRequest(oauth.tokens.access_token, 'tools/call', { name: 'ledger_rule_post', arguments: { operationId: 'rule-revoked-race', ...post(rule.id, oauth.browser.memberId) } }));
  const text = await response.text();
  expect(text).not.toContain('Edited during acceptance');
  expect(text).toContain('forbidden');
});
it('recovers identical concurrent replay before returning any newly changed rule conflict', async () => {
  const oauth = await personalOAuth('member', 'compat-rule-replay'), rule = await createRule(oauth.browser);
  const args = { operationId: 'rule-concurrent-replay', ...post(rule.id, oauth.browser.memberId) };
  let accepted: unknown;
  const database = beforeBatch(env.DB, async () => {
    accepted = await call(oauth.tokens.access_token, 'ledger_rule_post', args);
    await env.DB.prepare('UPDATE expense_rules SET version=version+1 WHERE id=?').bind(rule.id).run();
  });
  expect(await call(oauth.tokens.access_token, 'ledger_rule_post', args, overriddenFetch({ DB: database }))).toEqual(accepted);
  expect(accepted).toMatchObject({ structuredContent: { status: 'accepted' } });
  expect(await call(oauth.tokens.access_token, 'ledger_rule_post', args)).toEqual(accepted);
});
it('gives an existing source collision precedence over a changed current rule', async () => {
  const oauth = await personalOAuth('member', 'compat-source-priority'), rule = await createRule(oauth.browser);
  let existingId: string | undefined;
  const database = beforeBatch(env.DB, async () => {
    const accepted = await call(oauth.tokens.access_token, 'ledger_rule_post', { operationId: 'source-winner', ...post(rule.id, oauth.browser.memberId) });
    existingId = accepted.structuredContent.entry.id;
    await env.DB.prepare('UPDATE expense_rules SET version=version+1 WHERE id=?').bind(rule.id).run();
  });
  const result = await call(oauth.tokens.access_token, 'ledger_rule_post', { operationId: 'source-loser', ...post(rule.id, oauth.browser.memberId) }, overriddenFetch({ DB: database }));
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'conflict', entityId: existingId, current: { id: existingId, source: { ruleId: rule.id } } } });
});
it('advertises exactly one supported kind for each specialized create tool and calls every advertised variant', async () => {
  const oauth = await personalOAuth('member', 'compat-discovery'), person = oauth.browser.memberId, token = oauth.tokens.access_token;
  const listed = (await rpc(await realFetch(mcpRequest(token)))).result.tools as { name: string; inputSchema: { properties: { entry: { properties?: { kind: { const: string } }; oneOf?: unknown[]; anyOf?: unknown[] } } }; annotations: { readOnlyHint: boolean; idempotentHint: boolean }; description: string }[];
  for (const kind of ['expense', 'refund', 'payment']) {
    const tool = listed.find(tool => tool.name === `ledger_${kind}_create`)!;
    expect(tool.inputSchema.properties.entry.properties?.kind.const).toBe(kind);
    expect(tool.inputSchema.properties.entry.oneOf).toBeUndefined();
    expect(tool.inputSchema.properties.entry.anyOf).toBeUndefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tool.description).toContain('without executing a bank transfer');
  }
  const expense = bill(100, { payers: [{ memberId: person, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: person, kind: 'equal' }] } } });
  const accepted = await call(token, 'ledger_expense_create', { operationId: 'schema-expense', entry: expense });
  expect(accepted).toMatchObject({ structuredContent: { status: 'accepted' } });
  const refund = { kind: 'refund', expenseId: accepted.structuredContent.entry.id, date: expense.date, description: 'Returned', currency: 'INR', totalMinor: 20, payers: [{ memberId: person, amountMinor: 20 }], shares: [{ memberId: person, amountMinor: 20 }] };
  expect(await call(token, 'ledger_refund_create', { operationId: 'schema-refund', entry: refund })).toMatchObject({ structuredContent: { status: 'accepted' } });
  expect(await call(token, 'ledger_payment_create', { operationId: 'schema-payment', entry: { kind: 'payment', date: expense.date, currency: 'INR', totalMinor: 10, senderId: person, receiverId: 'local-owner', method: 'cash' } })).toMatchObject({ structuredContent: { status: 'accepted' } });
  for (const [name, entry] of [['ledger_payment_create', expense], ['ledger_expense_create', { ...expense, actorId: 'local-owner' }]]) {
    const response = await rpc(await realFetch(mcpRequest(token, 'tools/call', { name, arguments: { operationId: 'schema-invalid', entry } })));
    expect(response.error || response.result?.isError).toBeTruthy();
  }
});
