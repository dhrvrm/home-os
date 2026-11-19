import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { overriddenFetch, browserProof, browserRequest, data, realFetch } from './oauth-fixtures';
import { bill } from './ledger-fixtures';

it('offers authoritative allocation preview to a current viewer without accepting money', async () => {
  const viewer = await browserProof('viewer', 'ledger-preview-reader');
  const input = bill(101, { payers: [{ memberId: viewer.memberId, amountMinor: 101 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: viewer.memberId, kind: 'equal' }, { memberId: 'local-owner', kind: 'equal' }] } } });
  const response = await realFetch(browserRequest(viewer, '/api/v1/ledger/preview', input));
  expect(response.status).toBe(200);
  expect(await data(response)).toMatchObject({ allocation: { totalMinor: 101, shares: [{ memberId: viewer.memberId, amountMinor: 51 }, { memberId: 'local-owner', amountMinor: 50 }] } });
  expect((await realFetch(browserRequest(viewer, '/api/v1/ledger/expenses', input, { 'X-Operation-ID': 'viewer-create' }))).status).toBe(403);
});

it('maps malformed strict payloads to 400 and raw oversized UTF-8/escaped bodies to 413', async () => {
  const writer = await browserProof('member', 'ledger-body-writer');
  const original = browserRequest(writer, '/api/v1/ledger/expenses', {}, { 'X-Operation-ID': 'ledger-malformed' });
  for (const body of ['{', JSON.stringify({ ...bill(), householdId: 'foreign' }), JSON.stringify({ ...bill(), totalMinor: '1+1' })]) {
    const response = await realFetch(new Request(original, { body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ data: null, error: { code: 'invalid_request' } });
  }
  for (const body of [' '.repeat(65537), '"' + '\\u0061'.repeat(11000) + '"', '界'.repeat(22000)]) {
    const response = await realFetch(new Request(original, { body }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ data: null, error: { code: 'payload_too_large' } });
  }
});

it('accepts exactly 64 KiB and refuses unknown or duplicated query claims canonically', async () => {
  const reader = await browserProof('viewer', 'ledger-exact-limit');
  const input = bill();
  const raw = JSON.stringify(input);
  const response = await realFetch(new Request(browserRequest(reader, '/api/v1/ledger/preview', input), { body: raw.padEnd(65536, ' ') }));
  expect(response.status).toBe(200);
  for (const query of ['limit=1&limit=2', 'actorId=local-owner', 'limit=abc', 'from=2026-02-30']) {
    expect((await realFetch(browserRequest(reader, `/api/v1/ledger/entries?${query}`))).status).toBe(400);
  }
});
it('suppresses revoked direct command disclosure after acceptance while retaining its accepted money', async () => {
  const writer = await browserProof('member', 'ledger-http-final-race');
  const entry = bill(100, { payers: [{ memberId: writer.memberId, amountMinor: 100 }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: writer.memberId, kind: 'equal' }] } } });
  const database = new Proxy(env.DB, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const result = await target.batch(statements);
      await env.DB.prepare('DELETE FROM auth_sessions WHERE public_id=?').bind(writer.sessionId).run();
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await overriddenFetch({ DB: database })(browserRequest(writer, '/api/v1/ledger/expenses', entry, { 'X-Operation-ID': 'http-final-race' }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ data: null, error: { code: 'forbidden' } });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM ledger_revisions WHERE operation_id='http-final-race'").first()).toMatchObject({ count: 1 });
});
