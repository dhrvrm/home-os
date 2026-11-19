import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import recipeFrame from './schema-valid-large-recipe-call.json';
import { bill } from './ledger-fixtures';
import { personalOAuth, mcpRequest, realFetch, resetOAuthFixtures, browserRequest } from './oauth-fixtures';

beforeEach(resetOAuthFixtures);
async function rpc(response: Response) {
  const text = await response.text();
  return JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data: '))!.slice(6) : text);
}
async function send(token: string, raw: string | Uint8Array, headers: Record<string, string> = {}, chunked = false) {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
  const body = chunked ? new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
    for (let offset = 0; offset < bytes.byteLength; offset += 4093) controller.enqueue(bytes.slice(offset, offset + 4093));
    controller.close();
  } }) : bytes;
  const request = mcpRequest(token);
  const requestHeaders = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers)) requestHeaders.set(name, value);
  return realFetch(new Request(request, { headers: requestHeaders, body }));
}
const financialFrame = (name = 'ledger_balances') => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

it('accepts the supplied schema-valid 73142-byte recipe through current OAuth and the installed handler', async () => {
  const oauth = await personalOAuth('member', 'framing-recipe');
  const raw = JSON.stringify(recipeFrame);
  expect(new TextEncoder().encode(raw).byteLength).toBe(73142);
  const response = await send(oauth.tokens.access_token, raw);
  expect(response.status).toBe(200);
  expect(await rpc(response)).toMatchObject({ result: { structuredContent: { status: 'accepted', recipe: { name: recipeFrame.params.arguments.name, instructions: recipeFrame.params.arguments.instructions } } } });
});
it('accepts an escaped maximal recipe without treating nested ledger tool text as a financial call', async () => {
  const oauth = await personalOAuth('member', 'framing-escaped-recipe');
  const frame = structuredClone(recipeFrame);
  frame.params.arguments.instructions = 'ledger_'.padEnd(12000, '菜');
  const raw = JSON.stringify(frame).replace(/[^\x00-\x7f]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
  expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(65536);
  const response = await send(oauth.tokens.access_token, raw, { 'content-length': '1' }, true);
  expect(response.status).toBe(200);
  expect(await rpc(response)).toMatchObject({ result: { structuredContent: { status: 'accepted' } } });
});
it.each([false, true])('uses the original financial envelope byte boundary with chunked=%s and false length', async chunked => {
  const oauth = await personalOAuth('viewer', 'framing-boundary');
  const raw = financialFrame();
  const accepted = await send(oauth.tokens.access_token, raw.padEnd(65536), { 'content-length': '1' }, chunked);
  expect(accepted.status).toBe(200);
  expect(await rpc(accepted)).toHaveProperty('result.structuredContent');
  const refused = await send(oauth.tokens.access_token, raw.padEnd(65537), { 'content-length': '1' }, chunked);
  expect(refused.status).toBe(413);
  expect(refused.headers.get('cache-control')).toBe('no-store');
  expect(await refused.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { data: { code: 'payload_too_large' } } });
});
it.each(['escaped', 'unknown', 'duplicate', 'bom'])('classifies %s financial names using the same decoded JSON semantics as dispatch', async mode => {
  const oauth = await personalOAuth('viewer', 'framing-name');
  let raw = financialFrame(mode === 'unknown' ? 'ledger_unknown' : 'ledger_balances');
  if (mode === 'escaped') raw = raw.replace('ledger_', '\\u006cedger_').replace('tools/call', 'tools\\/call');
  if (mode === 'duplicate') raw = raw.replace('"name":', '"name":"recipes_create","name":');
  if (mode === 'bom') raw = '\ufeff' + raw;
  raw += ' '.repeat(65537 - new TextEncoder().encode(raw).byteLength);
  expect((await send(oauth.tokens.access_token, raw)).status).toBe(413);
});
it('rejects an entire oversized mixed financial batch without executing its valid recipe member', async () => {
  const oauth = await personalOAuth('member', 'framing-batch');
  const recipe = structuredClone(recipeFrame); recipe.params.arguments.operationId = 'mixed-batch-recipe';
  const raw = JSON.stringify([recipe, JSON.parse(financialFrame())]);
  expect((await send(oauth.tokens.access_token, raw)).status).toBe(413);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM household_command_receipts WHERE operation_id='mixed-batch-recipe'").first()).toMatchObject({ count: 0 });
});
it('bounds all nonfinancial frames at the installed four MiB ceiling', async () => {
  const oauth = await personalOAuth('viewer', 'framing-outer-limit');
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).padEnd(4194305);
  expect((await send(oauth.tokens.access_token, raw, { 'content-length': '1' }, true)).status).toBe(413);
  expect((await send(oauth.tokens.access_token, raw.slice(0, 4194304), { 'content-length': '1' }, true)).status).toBe(200);
});
it('rejects malformed UTF-8 comment text before any accepted comment or operation', async () => {
  const oauth = await personalOAuth('member', 'framing-utf8');
  const entry = bill(100, { payers: [{ memberId: oauth.browser.memberId, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: oauth.browser.memberId, kind: 'equal' }] } } });
  const created = await rpc(await realFetch(mcpRequest(oauth.tokens.access_token, 'tools/call', { name: 'ledger_expense_create', arguments: { operationId: 'utf8-parent', entry } })));
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ledger_comment_add', arguments: { operationId: 'utf8-comment', entryId: created.result.structuredContent.entry.id, expectedVersion: 1, text: 'invalid#text' } } });
  const bytes = new TextEncoder().encode(raw); bytes[raw.indexOf('#')] = 0xff;
  const response = await send(oauth.tokens.access_token, bytes);
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  const httpRaw = JSON.stringify({ text: 'invalid#text' });
  const httpBytes = new TextEncoder().encode(httpRaw); httpBytes[httpRaw.indexOf('#')] = 0xff;
  const httpRequest = browserRequest(oauth.browser, `/api/v1/ledger/entries/${created.result.structuredContent.entry.id}/comments`, {}, { 'X-Operation-ID': 'utf8-http-comment', 'If-Match': '1' });
  expect((await realFetch(new Request(httpRequest, { body: httpBytes }))).status).toBe(400);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE operation_id='utf8-http-comment'").first()).toMatchObject({ count: 0 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ledger_comments WHERE operation_id='utf8-comment'").first()).toMatchObject({ count: 0 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM household_command_receipts WHERE operation_id='utf8-comment'").first()).toMatchObject({ count: 0 });
});
it('preserves initialize, list, notification and ordinary batch handling in the installed SDK', async () => {
  const oauth = await personalOAuth('viewer', 'framing-protocol'), token = oauth.tokens.access_token;
  const initialized = await realFetch(mcpRequest(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'regression', version: '1' } }));
  expect(initialized.status).toBe(200);
  expect(await rpc(initialized)).toHaveProperty('result.protocolVersion');
  expect((await realFetch(mcpRequest(token))).status).toBe(200);
  const notification = await send(token, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  expect(notification.status).toBe(202);
  const batch = await send(token, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]));
  expect(batch.status).toBe(200);
  const text = await batch.text();
  const results = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  expect(results).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }]);
});

it('forwards BOM and duplicate-key semantics consistently below the financial ceiling', async () => {
  const oauth = await personalOAuth('viewer', 'framing-text-semantics');
  const raw = '\ufeff' + financialFrame().replace('"name":', '"name":"recipes_create","name":');
  const response = await send(oauth.tokens.access_token, raw);
  expect(response.status).toBe(200);
  expect(await rpc(response)).toHaveProperty('result.structuredContent');
});
it('retains the installed SDK maximum batch size', async () => {
  const oauth = await personalOAuth('viewer', 'framing-max-batch');
  const raw = JSON.stringify(Array.from({ length: 101 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' })));
  const response = await send(oauth.tokens.access_token, raw);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: -32600 } });
});
