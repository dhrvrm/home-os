import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { mcpRequest, personalOAuth, realFetch, resetOAuthFixtures, measuredFetch, browserRequest, data } from './oauth-fixtures';

async function rpc(response: Response) {
  const body = await response.text();
  const json = body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body;
  return JSON.parse(json);
}
async function invoke(token: string, name: string, args: unknown, fetch = realFetch) {
  return (await rpc(await fetch(mcpRequest(token, 'tools/call', { name, arguments: args })))).result;
}
beforeEach(async () => {
  await resetOAuthFixtures();
  await env.DB.batch([env.DB.prepare('DELETE FROM inventory_items'), env.DB.prepare('DELETE FROM expense_rules')]);
});
describe('connected domain parity', () => {
  it('creates stock with durable replay, version conflicts, API parity and attributed activity', async () => {
    const oauth = await personalOAuth('member', 'mcp-writer');
    const args = { operationId: 'parity-create', name: 'Parity rice', trackingMode: 'exact', quantity: 10, minQuantity: 2 };
    const created = await invoke(oauth.tokens.access_token, 'inventory_create', args);
    expect(created).toMatchObject({ structuredContent: { status: 'accepted', item: { name: 'Parity rice', version: 1 } } });
    const item = created.structuredContent.item;
    expect(await invoke(oauth.tokens.access_token, 'inventory_create', args)).toMatchObject({ structuredContent: { item: { id: item.id, version: 1 } } });
    expect(await invoke(oauth.tokens.access_token, 'inventory_create', { ...args, name: 'Changed' })).toMatchObject({ isError: true });
    const stocked = await invoke(oauth.tokens.access_token, 'inventory_stock', { itemId: item.id, operationId: 'parity-stock', expectedVersion: 1, type: 'consume', quantity: 3 });
    expect(stocked).toMatchObject({ structuredContent: { status: 'accepted', item: { quantity: 7, version: 2 } } });
    expect(await data(await realFetch(browserRequest(oauth.browser, `/api/v1/items/${item.id}`)))).toMatchObject({ item: { quantity: 7, version: 2 } });
    expect(await invoke(oauth.tokens.access_token, 'inventory_update', { itemId: item.id, operationId: 'parity-stale', expectedVersion: 1, name: 'Stale' })).toMatchObject({ isError: true, structuredContent: { status: 'conflict', actualVersion: 2, current: { id: item.id, version: 2 } } });
    const activity = await invoke(oauth.tokens.access_token, 'activity_list', { entityId: item.id });
    expect(activity.structuredContent.events).toHaveLength(2);
    expect(activity.structuredContent.events[1]).toMatchObject({ actorId: 'mcp-writer', actorType: 'mcp', source: 'mcp', mcpTool: 'inventory_stock', mcpClientId: oauth.client.client_id });
  });
  it('pages inventory at SQL boundary through real OAuth with a conservative binding budget', async () => {
    const oauth = await personalOAuth('viewer', 'mcp-reader');
    const now = new Date().toISOString();
    await env.DB.batch(Array.from({ length: 61 }, (_, index) => env.DB.prepare(`INSERT INTO inventory_items (id,household_id,name,normalized_name,location,unit,tracking_mode,quantity,stock_level,level_percent,min_quantity,version,created_at,updated_at) VALUES (?, 'home', ?, ?, 'Pantry','item','simple',0,'okay',50,0,1,?,?)`).bind(`page-${index.toString().padStart(3,'0')}`, `Paged ${index}`, `paged ${index}`, now, now)));
    const seen: string[] = []; let cursor: string | undefined;
    do {
      const measured = measuredFetch();
      const result = await invoke(oauth.tokens.access_token, 'inventory_list', { query: 'Paged', limit: 20, ...(cursor ? { cursor } : {}) }, measured.fetch);
      expect(result.structuredContent.items.length).toBeLessThanOrEqual(20);
      seen.push(...result.structuredContent.items.map((item: { id: string }) => item.id));
      cursor = result.structuredContent.nextCursor ?? undefined;
      expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
    } while (cursor);
    expect(new Set(seen).size).toBe(61);
    expect(seen).toHaveLength(61);
    const exported: string[] = []; cursor = undefined;
    do {
      const measured = measuredFetch();
      const page = await invoke(oauth.tokens.access_token, 'inventory_export', { section: 'items', limit: 20, ...(cursor ? { cursor } : {}) }, measured.fetch);
      exported.push(...page.structuredContent.items.map((item: { id: string }) => item.id)); cursor = page.structuredContent.nextCursor ?? undefined;
      expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
    } while (cursor);
    expect(exported).toEqual(seen);
  });
});

it('covers inventory metadata and lifecycle plus simple stock tracking', async () => {
  const oauth = await personalOAuth('member', 'lifecycle-writer'), token = oauth.tokens.access_token;
  const created = await invoke(token, 'inventory_create', { operationId: 'simple-create', name: 'Soap', levelPercent: 50, restockIntervalDays: 7 });
  const id = created.structuredContent.item.id;
  expect(await invoke(token, 'inventory_update', { operationId: 'simple-update', itemId: id, expectedVersion: 1, categories: ['Bathroom'], alternativeNames: ['साबुन'], restockIntervalDays: 10 })).toMatchObject({ structuredContent: { item: { version: 2, categories: ['Bathroom'], restockDue: { intervalDays: 10 } } } });
  expect(await invoke(token, 'inventory_stock', { operationId: 'simple-consume', itemId: id, expectedVersion: 2, type: 'consume' })).toMatchObject({ structuredContent: { item: { version: 3, levelPercent: 25, stockLevel: 'low' } } });
  expect(await invoke(token, 'inventory_stock', { operationId: 'simple-restock', itemId: id, expectedVersion: 3, type: 'restock' })).toMatchObject({ structuredContent: { item: { version: 4, levelPercent: 100, restockDue: { lastRestockedAt: expect.any(String) } } } });
  expect(await invoke(token, 'inventory_stock', { operationId: 'simple-mark', itemId: id, expectedVersion: 4, type: 'mark_level', levelPercent: 0 })).toMatchObject({ structuredContent: { item: { version: 5, stockLevel: 'out' } } });
  expect(await invoke(token, 'inventory_archive', { operationId: 'simple-archive', itemId: id, expectedVersion: 5 })).toMatchObject({ structuredContent: { item: { version: 6, archivedAt: expect.any(String) } } });
  expect(await invoke(token, 'inventory_restore', { operationId: 'simple-restore', itemId: id, expectedVersion: 6 })).toMatchObject({ structuredContent: { item: { version: 7, archivedAt: null } } });
  expect(await invoke(token, 'inventory_get', { itemId: id, limit: 2 })).toMatchObject({ structuredContent: { item: { id }, events: expect.any(Array), nextCursor: expect.any(String) } });
});

it('shares recurring-rule validation, shares, conflicts and lifecycle with the API', async () => {
  const oauth = await personalOAuth('member', 'rule-writer'), token = oauth.tokens.access_token;
  const args = { operationId: 'rule-create', name: 'Power', amountMinor: 101, currency: 'INR', cadence: { unit: 'month', interval: 1, anchorDate: '2026-01-01' }, participants: [{ memberId: 'rule-writer' }, { memberId: 'local-owner' }] };
  const created = await invoke(token, 'expenses_create', args), rule = created.structuredContent.rule;
  expect(created).toMatchObject({ structuredContent: { status: 'accepted', rule: { version: 1, amountMinor: 101 } } });
  expect(rule.participants.reduce((sum: number, p: { shareMinor: number }) => sum + p.shareMinor, 0)).toBe(101);
  expect(await invoke(token, 'expenses_create', args)).toMatchObject({ structuredContent: { rule: { id: rule.id, version: 1 } } });
  expect(await invoke(token, 'expenses_update', { operationId: 'rule-update', ruleId: rule.id, expectedVersion: 1, amountMinor: 202 })).toMatchObject({ structuredContent: { rule: { version: 2, amountMinor: 202 } } });
  expect(await data(await realFetch(browserRequest(oauth.browser, `/api/v1/expenses/${rule.id}`)))).toMatchObject({ rule: { version: 2, amountMinor: 202 } });
  expect(await invoke(token, 'expenses_update', { operationId: 'rule-stale', ruleId: rule.id, expectedVersion: 1, name: 'Stale' })).toMatchObject({ isError: true, structuredContent: { status: 'conflict', current: { version: 2 } } });
  expect(await invoke(token, 'expenses_update', { operationId: 'rule-invalid', ruleId: rule.id, expectedVersion: 2, cadence: { unit: 'month', interval: 0, anchorDate: '2026-01-01' } })).toMatchObject({ isError: true, structuredContent: { status: 'invalid' } });
  expect(await invoke(token, 'expenses_archive', { operationId: 'rule-archive', ruleId: rule.id, expectedVersion: 2 })).toMatchObject({ structuredContent: { rule: { version: 3, archivedAt: expect.any(String) } } });
  expect(await invoke(token, 'expenses_restore', { operationId: 'rule-restore', ruleId: rule.id, expectedVersion: 3 })).toMatchObject({ structuredContent: { rule: { version: 4, archivedAt: null } } });
  expect(await invoke(token, 'expenses_get', { ruleId: rule.id })).toMatchObject({ structuredContent: { rule: { id: rule.id, version: 4 } } });
  const audit = await invoke(token, 'activity_list', { entityType: 'expense_rule', entityId: rule.id });
  expect(audit.structuredContent.events).toHaveLength(4);
});

it('keeps every tool within fifty real-provider D1 and KV requests, including maximal item declarations and failures', async () => {
  const oauth = await personalOAuth('member', 'budget-writer'), token = oauth.tokens.access_token;
  const observations: Record<string, number> = {};
  const call = async (name: string, args: unknown) => {
    const measured = measuredFetch(); const result = await invoke(token, name, args, measured.fetch);
    observations[name] = Math.max(observations[name] ?? 0, measured.requests.d1 + measured.requests.kv);
    expect(observations[name]).toBeLessThanOrEqual(50); return result;
  };
  const categories = Array.from({ length: 9 }, (_, i) => `Category ${i}`), alternativeNames = Array.from({ length: 8 }, (_, i) => `Alias ${i}`);
  const created = await call('inventory_create', { operationId: 'budget-max-create', name: 'Maximum declaration', categories, alternativeNames, restockIntervalDays: 2 });
  expect(created.isError).not.toBe(true);
  const itemId = created.structuredContent.item.id;
  await call('inventory_update', { operationId: 'budget-max-update', expectedVersion: 1, itemId, categories, alternativeNames });
  await call('inventory_stock', { operationId: 'budget-stock', expectedVersion: 2, itemId, type: 'restock' });
  await call('inventory_archive', { operationId: 'budget-archive', expectedVersion: 3, itemId });
  await call('inventory_restore', { operationId: 'budget-restore', expectedVersion: 4, itemId });
  await call('inventory_list', { limit: 50 }); await call('inventory_attention', { limit: 50 });
  await call('inventory_get', { itemId }); await call('inventory_events', { itemId });
  await call('inventory_export', { section: 'items' }); await call('inventory_export', { section: 'events' }); await call('activity_list', {});
  const rule = await call('expenses_create', { operationId: 'budget-rule', name: 'Water', amountMinor: 100, cadence: { unit: 'month', interval: 1, anchorDate: '2026-01-01' }, participants: [{ memberId: 'budget-writer' }] });
  const ruleId = rule.structuredContent.rule.id;
  await call('expenses_update', { operationId: 'budget-rule-update', ruleId, expectedVersion: 1, amountMinor: 200 });
  await call('expenses_archive', { operationId: 'budget-rule-archive', ruleId, expectedVersion: 2 });
  await call('expenses_restore', { operationId: 'budget-rule-restore', ruleId, expectedVersion: 3 });
  await call('expenses_list', {}); await call('expenses_get', { ruleId });
  await call('inventory_update', { operationId: 'budget-stale', itemId, expectedVersion: 1, name: 'Stale' });
  await call('inventory_get', { itemId: 'wrong-household' });
  await call('inventory_list', { cursor: 'invalid' });
  expect(Math.max(...Object.values(observations))).toBeLessThanOrEqual(50);
});

it('rejects forged identity fields and viewer/ceiling writes, and revoked replay cannot disclose results', async () => {
  const oauth = await personalOAuth('member', 'guarded-writer'), token = oauth.tokens.access_token;
  const created = await invoke(token, 'inventory_create', { operationId: 'guarded-create', name: 'Guarded' });
  const itemId = created.structuredContent.item.id;
  for (const field of ['actorId','householdId','role','authority']) {
    const response = await rpc(await realFetch(mcpRequest(token, 'tools/call', { name: 'inventory_update', arguments: { operationId: `forged-${field}`, itemId, expectedVersion: 1, name: 'Forged', [field]: 'local-owner' } })));
    expect(response.error || response.result?.isError).toBeTruthy();
  }
  const viewer = await personalOAuth('viewer', 'ceiling-reader');
  const listed = await rpc(await realFetch(mcpRequest(viewer.tokens.access_token)));
  expect(listed.result.tools.some((tool: { name: string }) => tool.name === 'inventory_create')).toBe(false);
  await env.DB.prepare("UPDATE members SET role = 'member' WHERE id = 'ceiling-reader'").run();
  expect((await rpc(await realFetch(mcpRequest(viewer.tokens.access_token)))).result.tools.some((tool: { name: string }) => tool.name === 'inventory_create')).toBe(false);
  const forged = await rpc(await realFetch(mcpRequest(viewer.tokens.access_token, 'tools/call', { name: 'inventory_create', arguments: { operationId: 'viewer-forge', name: 'Forbidden' } })));
  expect(forged.error || forged.result?.isError).toBeTruthy();
  await env.DB.prepare("UPDATE mcp_connections SET status = 'revoked' WHERE member_id = 'guarded-writer'").run();
  const measured = measuredFetch();
  const denied = await measured.fetch(mcpRequest(token, 'tools/call', { name: 'inventory_create', arguments: { operationId: 'guarded-create', name: 'Guarded' } }));
  expect(denied.status).toBe(401); expect(await denied.text()).not.toContain(itemId);
  expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?").bind(itemId).first()).toMatchObject({ count: 1 });
});

it('pages more than fifty history/export observations and preserves complete forecast and declared restock signals', async () => {
  const oauth = await personalOAuth('member', 'history-writer'), token = oauth.tokens.access_token;
  const now = Date.now(), old = new Date(now - 30 * 86400000).toISOString();
  const item = (await invoke(token, 'inventory_create', { operationId: 'history-create', name: 'Projection oats', trackingMode: 'exact', quantity: 100, minQuantity: 1, restockIntervalDays: 7 })).structuredContent.item;
  await env.DB.prepare('UPDATE inventory_items SET created_at = ? WHERE id = ?').bind(old, item.id).run();
  const times = Array.from({ length: 63 }, (_, i) => new Date(now - (20 - i / 10) * 86400000).toISOString());
  await env.DB.batch(times.map((time, i) => env.DB.prepare(`INSERT INTO inventory_stock_events (id, household_id, item_id, event_type, quantity, stock_level, level_percent, note, actor_id, occurred_at, created_at) VALUES (?, 'home', ?, 'consume', 1, 'okay', 0, '', 'history-writer', ?, ?)`).bind(`history-${i.toString().padStart(3,'0')}`, item.id, time, time)));
  const list = await invoke(token, 'inventory_list', { query: 'Projection oats', limit: 1 });
  expect(list.structuredContent.items[0]).toMatchObject({ forecast: { daysRemaining: 31.7, confidence: 'high' }, cadence: { averageIntervalDays: 0.1, confidence: 'high' }, restockDue: { status: 'overdue', lastRestockedAt: null } });
  expect(await invoke(token, 'inventory_attention', { limit: 50 })).toMatchObject({ structuredContent: { items: expect.arrayContaining([expect.objectContaining({ id: item.id, attentionReasons: ['overdue'] })]) } });
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const measured = measuredFetch();
    const page = await invoke(token, 'inventory_events', { itemId: item.id, limit: 17, ...(cursor ? { cursor } : {}) }, measured.fetch);
    seen.push(...page.structuredContent.events.map((event: { id: string }) => event.id)); cursor = page.structuredContent.nextCursor ?? undefined;
    expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  } while (cursor);
  expect(seen).toHaveLength(63); expect(new Set(seen).size).toBe(63);
  const exported: string[] = []; cursor = undefined;
  do {
    const page = await invoke(token, 'inventory_export', { section: 'events', limit: 20, ...(cursor ? { cursor } : {}) });
    exported.push(...page.structuredContent.events.filter((event: { itemId: string }) => event.itemId === item.id).map((event: { id: string }) => event.id)); cursor = page.structuredContent.nextCursor ?? undefined;
  } while (cursor);
  expect(exported).toEqual(seen);
});

it('continues attention after an empty page and exposes a truthful bounded legacy catalog', async () => {
  const oauth = await personalOAuth('viewer', 'attention-reader'), token = oauth.tokens.access_token, now = new Date().toISOString();
  await env.DB.batch(Array.from({ length: 52 }, (_, i) => env.DB.prepare(`INSERT INTO inventory_items (id, household_id, name, normalized_name, location, unit, tracking_mode, quantity, stock_level, level_percent, min_quantity, created_at, updated_at) VALUES (?, 'home', ?, ?, 'Pantry','item','simple',0,?,50,0,?,?)`).bind(`attention-${i.toString().padStart(3,'0')}`, `Attention ${i}`, `attention ${i}`, i === 51 ? 'out' : 'okay', now, now)));
  const first = await invoke(token, 'inventory_attention', { limit: 20 });
  expect(first.structuredContent).toMatchObject({ items: [], complete: false, nextCursor: expect.any(String) });
  const seen: string[] = []; let cursor = first.structuredContent.nextCursor;
  do { const page = await invoke(token, 'inventory_attention', { limit: 20, cursor }); seen.push(...page.structuredContent.items.map((item: { id: string }) => item.id)); cursor = page.structuredContent.nextCursor; } while (cursor);
  expect(seen).toContain('attention-051');
  const measured = measuredFetch(); const catalog = await rpc(await measured.fetch(mcpRequest(token, 'resources/read', { uri: 'home-os://inventory/catalog' })));
  const page = JSON.parse(catalog.result.contents[0].text);
  expect(page.items).toHaveLength(25); expect(page.nextCursor).toEqual(expect.any(String)); expect(page.continuationTool).toBe('inventory_list');
  expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  expect(JSON.stringify(catalog)).not.toMatch(/token_hash|credential_version|access_token|password_hash|provider_grant_id/);
});

it.each(['revoked','demoted','credential-replaced'])('refuses a command if authority is %s immediately before atomic acceptance', async mode => {
  const oauth = await personalOAuth('member', 'racing-writer'), token = oauth.tokens.access_token;
  let changed = false;
  const database = new Proxy(env.DB, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!changed) {
        changed = true;
        if (mode === 'revoked') await env.DB.prepare("UPDATE mcp_connections SET status = 'revoked' WHERE member_id = 'racing-writer'").run();
        else if (mode === 'demoted') await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE id = 'racing-writer'").run();
        else await env.DB.prepare("UPDATE auth_accounts SET credential_version = credential_version + 1 WHERE member_id = 'racing-writer'").run();
      }
      return target.batch(statements);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const { countedD1, countedKV } = await import('./d1-budget');
  const { overriddenFetch } = await import('./oauth-fixtures');
  const db = countedD1(database, 50, true), kv = countedKV(env.OAUTH_KV);
  const result = await invoke(token, 'inventory_create', { operationId: 'racing-create', id: 'racing-item', name: 'Must not commit' }, overriddenFetch({ DB: db.database, OAUTH_KV: kv.namespace }));
  expect(changed).toBe(true);
  expect(result).toMatchObject({ isError: true, structuredContent: { status: 'refused' } });
  expect(db.calls() + kv.calls()).toBeLessThanOrEqual(50);
  for (const table of ['inventory_items','household_command_receipts','audit_events']) {
    const column = table === 'inventory_items' ? 'id' : 'operation_id';
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).bind(table === 'inventory_items' ? 'racing-item' : 'racing-create').first()).toMatchObject({ count: 0 });
  }
});

it('pages recurring rules and refuses other-household subjects and actor receipt reuse', async () => {
  const oauth = await personalOAuth('member', 'boundary-writer'), token = oauth.tokens.access_token;
  const now = new Date().toISOString();
  await env.DB.batch(Array.from({ length: 57 }, (_, i) => env.DB.prepare(`INSERT INTO expense_rules (id, household_id, name, amount_minor, currency, cadence_unit, cadence_interval, anchor_date, version, created_at, updated_at) VALUES (?, 'home', ?, 100, 'INR', 'month', 1, '2026-01-01', 1, ?, ?)`).bind(`rule-page-${i.toString().padStart(3,'0')}`, `Rule ${i}`, now, now)));
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const measured = measuredFetch();
    const page = await invoke(token, 'expenses_list', { limit: 20, ...(cursor ? { cursor } : {}) }, measured.fetch);
    seen.push(...page.structuredContent.rules.map((rule: { id: string }) => rule.id)); cursor = page.structuredContent.nextCursor ?? undefined;
    expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  } while (cursor);
  expect(seen).toHaveLength(57); expect(new Set(seen).size).toBe(57);
  await env.DB.prepare("INSERT INTO households (id,name,created_at,updated_at) VALUES ('elsewhere','Elsewhere',?,?) ON CONFLICT DO NOTHING").bind(now,now).run();
  await env.DB.prepare("UPDATE expense_rules SET household_id = 'elsewhere' WHERE id = 'rule-page-000'").run();
  expect(await invoke(token, 'expenses_get', { ruleId: 'rule-page-000' })).toMatchObject({ isError: true, structuredContent: { code: 'not_found' } });
  const args = { operationId: 'actor-receipt', name: 'Actor-bound item' };
  const created = await invoke(token, 'inventory_create', args);
  const second = await personalOAuth('member', 'different-actor');
  expect(await invoke(second.tokens.access_token, 'inventory_create', args)).toMatchObject({ isError: true, structuredContent: { status: 'conflict' } });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?').bind(created.structuredContent.item.id).first()).toMatchObject({ count: 1 });
});

it('keeps maximal expense participant updates and stale conflicts within the combined binding budget', async () => {
  const oauth = await personalOAuth('member','split-writer'), token = oauth.tokens.access_token, now = new Date().toISOString();
  await env.DB.batch(Array.from({ length: 12 }, (_, i) => env.DB.prepare("INSERT INTO members (id, household_id, display_name, role, created_at, updated_at) VALUES (?, 'home', ?, 'member', ?, ?) ON CONFLICT DO NOTHING").bind(`split-${i}`,`Split ${i}`,now,now)));
  const participants = Array.from({ length: 12 }, (_, i) => ({ memberId: `split-${i}` }));
  const create = measuredFetch(); const created = await invoke(token, 'expenses_create', { operationId: 'split-max-create', name: 'Max split', amountMinor: 1201, participants, cadence: { unit: 'week', interval: 2, anchorDate: '2026-01-01' } },create.fetch);
  const ruleId = created.structuredContent.rule.id;
  expect(create.requests.d1 + create.requests.kv).toBeLessThanOrEqual(50);
  const update = measuredFetch();
  expect(await invoke(token,'expenses_update',{ operationId:'split-max-update',ruleId,expectedVersion:1,amountMinor:2401,participants },update.fetch)).toMatchObject({ structuredContent:{ rule:{version:2} } });
  expect(update.requests.d1 + update.requests.kv).toBeLessThanOrEqual(50);
  const stale = measuredFetch();
  expect(await invoke(token,'expenses_update',{ operationId:'split-max-stale',ruleId,expectedVersion:1,amountMinor:3401,participants },stale.fetch)).toMatchObject({ isError:true,structuredContent:{status:'conflict',current:{version:2}} });
  expect(stale.requests.d1 + stale.requests.kv).toBeLessThanOrEqual(50);
  await env.DB.prepare("UPDATE members SET archived_at = ? WHERE id = 'split-0'").bind(now).run();
  expect(await invoke(token,'expenses_get',{ruleId})).toMatchObject({ structuredContent:{rule:{needsAttention:true}} });
  expect(await invoke(token,'expenses_create',{ operationId:'inactive-split',name:'Inactive',amountMinor:100,participants:[{memberId:'split-0'}],cadence:{unit:'month',interval:1,anchorDate:'2026-01-01'} })).toMatchObject({ isError:true,structuredContent:{status:'invalid',field:'participants'} });
});

it('retains Unicode names, aliases and locations across HTTP and SQL-paged searches', async () => {
  const oauth = await personalOAuth('member','unicode-writer'), token = oauth.tokens.access_token;
  const created = await invoke(token,'inventory_create',{operationId:'unicode-item',name:'Äpfel',alternativeNames:['ÖBST'],location:'KÜCHE',categories:['Früchte']});
  const id = created.structuredContent.item.id;
  for (const query of ['äpfel','öbst','küche','früchte']) {
    expect(await invoke(token,'inventory_list',{query})).toMatchObject({structuredContent:{items:[{id}]}});
    expect(await data(await realFetch(browserRequest(oauth.browser,`/api/v1/items?q=${encodeURIComponent(query)}`)))).toMatchObject({items:[{id}]});
  }
});

it('matches cross-field phrases in declared order through bounded empty inventory pages', async () => {
  const oauth = await personalOAuth('member', 'phrase-writer'), token = oauth.tokens.access_token;
  await invoke(token, 'inventory_create', { operationId: 'phrase-unrelated', id: 'phrase-00', name: 'Tea', categories: ['Drinks'], location: 'Shelf' });
  const plain = (await invoke(token, 'inventory_create', { operationId: 'phrase-plain', id: 'phrase-10', name: 'Milk', categories: ['Dairy'], location: 'Fridge' })).structuredContent.item;
  const ordered = (await invoke(token, 'inventory_create', { operationId: 'phrase-ordered', id: 'phrase-20', name: 'Milk', alternativeNames: ['White'], categories: ['Z pantry', 'Dairy'], location: 'Fridge' })).structuredContent.item;
  expect(plain.alternativeNames).toEqual([]);
  expect(ordered.categories).toEqual(['Z pantry', 'Dairy']);
  for (const [query, expectedId] of [['Milk Dairy', plain.id], ['Milk White Z pantry Dairy Fridge', ordered.id]]) {
    const http = await data<{ items: { id: string }[] }>(await realFetch(browserRequest(oauth.browser, `/api/v1/items?q=${encodeURIComponent(query)}`)));
    expect(http.items.map((item: { id: string }) => item.id)).toEqual([expectedId]);
    const seen: string[] = [];
    let cursor: string | undefined, first = true;
    do {
      const measured = measuredFetch();
      const response = await invoke(token, 'inventory_list', { query, limit: 1, ...(cursor ? { cursor } : {}) }, measured.fetch);
      expect(response.isError).not.toBe(true);
      const page = response.structuredContent;
      expect(page.items.length).toBeLessThanOrEqual(1);
      expect(page.count).toBe(page.items.length);
      if (first) {
        expect(page.items).toEqual([]);
        expect(page.nextCursor).toEqual(expect.any(String));
        first = false;
      }
      seen.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor ?? undefined;
      expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
    } while (cursor);
    expect(seen).toEqual([expectedId]);
  }
  expect(await invoke(token, 'inventory_list', { query: 'Milk Dairy', category: 'Dairy', stockLevel: 'okay' })).toMatchObject({ structuredContent: { items: [{ id: plain.id }] } });
});

it.each([{ limit: undefined, expected: 50 }, { limit: 100, expected: 100 }])('retains activity page size $expected and legacy after continuation over OAuth', async ({ limit, expected }) => {
  const oauth = await personalOAuth('viewer', 'activity-reader'), now = new Date().toISOString();
  await env.DB.batch(Array.from({ length: 107 }, (_, index) => env.DB.prepare(`INSERT INTO audit_events
    (id,household_id,entity_type,entity_id,action,actor_id,actor_type,source,operation_id,server_time,changes_json)
    VALUES (?, 'home', 'legacy_activity_fixture', 'legacy-feed', 'fixture.created', 'local-owner', 'member', 'pwa', ?, ?, '[]')`)
    .bind(`legacy-feed-${index}`, `legacy-feed-op-${index}`, now)));
  const seen: string[] = [];
  let after: string | undefined, first = true;
  do {
    const measured = measuredFetch();
    const response = await invoke(oauth.tokens.access_token, 'activity_list', {
      entityType: 'legacy_activity_fixture', ...(limit === undefined ? {} : { limit }), ...(after ? { after } : {}),
    }, measured.fetch);
    expect(response.isError).not.toBe(true);
    const page = response.structuredContent;
    if (first) {
      expect(page.events).toHaveLength(expected);
      expect(page.nextCursor).toEqual(expect.any(String));
      first = false;
    }
    seen.push(...page.events.map((event: { id: string }) => event.id));
    after = page.nextCursor ?? undefined;
    expect(measured.requests.d1 + measured.requests.kv).toBeLessThanOrEqual(50);
  } while (after);
  expect(seen).toEqual(Array.from({ length: 107 }, (_, index) => `legacy-feed-${index}`));
  expect(new Set(seen).size).toBe(107);
});

it('returns canonical split/minor-unit validation and never leaks binding diagnostics', async () => {
  const oauth = await personalOAuth('member','validation-writer'), token = oauth.tokens.access_token;
  const base = { name:'Split rule',amountMinor:101,currency:'INR',cadence:{unit:'month',interval:1,anchorDate:'2026-01-01'},participants:[{memberId:'validation-writer'}] };
  const fixed = await invoke(token,'expenses_create',{...base,operationId:'valid-fixed',participants:[{memberId:'validation-writer',override:{kind:'fixed',amountMinor:101}}]});
  expect(fixed).toMatchObject({structuredContent:{rule:{participants:[{shareMinor:101}]}}});
  for (const [operationId, input] of [
    ['fractional-amount',{amountMinor:1.5}],
    ['invalid-split',{participants:[{memberId:'validation-writer',override:{kind:'percent',basisPoints:11000}}]}],
    ['foreign-member',{participants:[{memberId:'not-a-household-member'}]}],
  ] as const) expect(await invoke(token,'expenses_create',{...base,...input,operationId})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
  const { overriddenFetch } = await import('./oauth-fixtures');
  const database = new Proxy(env.DB,{ get(target,key) {
    if (key === 'prepare') return (sql:string) => {
      if (sql.includes('FROM inventory_items i WHERE')) throw new Error('token_hash=private-proof password_hash=private-password');
      return target.prepare(sql);
    };
    const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const result = await invoke(token,'inventory_list',{},overriddenFetch({DB:database}));
  expect(result).toMatchObject({isError:true,structuredContent:{status:'unavailable',code:'temporarily_unavailable'}});
  const text=JSON.stringify(result); expect(text).not.toMatch(/private-proof|private-password|token_hash|password_hash/);
  expect(text).not.toContain(token);
});
