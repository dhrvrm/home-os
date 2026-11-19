import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { bill } from './ledger-fixtures';
import { countedD1, countedKV } from './d1-budget';
import { personalOAuth, mcpRequest, realFetch, resetOAuthFixtures, measuredFetch, browserRequest, overriddenFetch } from './oauth-fixtures';
async function rpc(response: Response) {
 const body=await response.text();
 return JSON.parse(body.startsWith('event:')||body.startsWith('data:')?body.split('\n').find(line=>line.startsWith('data: '))!.slice(6):body);
}
async function call(token:string,name:string,args:unknown,fetch=realFetch) { return (await rpc(await fetch(mcpRequest(token,'tools/call',{name,arguments:args})))).result; }
beforeEach(resetOAuthFixtures);
// Retain the original U5 comprehensive budget assertions; this dedicated gate
// remeasures the integrated implementation including post-U5 replay recovery.
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
  expect(result.isError,JSON.stringify(result)).not.toBe(true);
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
  console.log('U8 current combined D1+KV observations', observations);
});

/** The winning real request commits after this request's empty receipt read.
 * Only the losing request's D1/KV calls count toward its invocation budget. */
function afterFirstEmptyReceipt(database:D1Database,winner:()=>Promise<void>):D1Database {
 let injected=false;
 const originals=new WeakMap<object,D1PreparedStatement>();
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>{const proxy=new Proxy(statement,{get(target,key){
  if(key==='bind') return (...values:unknown[])=>wrap(target.bind(...values),sql);
  if(key==='first') return async (...args:unknown[])=>{
   const row=await Reflect.apply(target.first,target,args);
   if(sql.includes('LEFT JOIN household_command_receipts')) console.info('U8 receipt lookup',{authority:row?.authority_admitted,hasReceipt:row?.operation_id!==null});
   if(sql.includes('AS used')) console.info('U8 legacy-used lookup',row);
   if(!injected&&sql.includes('LEFT JOIN household_command_receipts')&&row?.operation_id===null){injected=true;await winner()}
   return row;
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});originals.set(proxy,statement);return proxy;};
 return new Proxy(database,{get(target,key){if(key==='prepare') return (sql:string)=>wrap(target.prepare(sql),sql);if(key==='batch') return (statements:D1PreparedStatement[])=>target.batch(statements.map(s=>originals.get(s)??s));const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}});
}
it.each(['correct','comment','post'] as const)('counts full OAuth plus conservative D1 for concurrent %s receipt recovery',async action=>{
 const oauth=await personalOAuth('member','integrated-budget'),token=oauth.tokens.access_token,person=oauth.browser.memberId;
 const input=bill(100,{payers:[{memberId:person,amountMinor:100}],allocation:{kind:'split',split:{mode:'equal',participants:[{memberId:person,kind:'equal'}]}}});
 const original=(await call(token,'ledger_expense_create',{operationId:'budget-original-'+action,entry:input})).structuredContent.entry;
 const tool=action==='correct'?'ledger_entry_correct':action==='comment'?'ledger_comment_add':'ledger_rule_post';
 let args:Record<string,unknown>={operationId:'budget-race-'+action,entryId:original.id,expectedVersion:1,...(action==='correct'?{entry:{...input,totalMinor:120,payers:[{memberId:person,amountMinor:120}]}}:{text:'Accepted once'})};
 if(action==='post'){
  const rule=(await call(token,'expenses_create',{operationId:'budget-source',name:'Budget source',amountMinor:100,currency:'INR',cadence:{unit:'month',interval:1,anchorDate:input.date},participants:[{memberId:person}]})).structuredContent.rule;
  args={operationId:'budget-race-'+action,ruleId:rule.id,expectedRuleVersion:1,period:0,date:input.date,payers:[{memberId:person,amountMinor:100}]};
 }
 let winnerResult:unknown;
 const d1=countedD1(env.DB,50,true),kv=countedKV(env.OAUTH_KV);
 const race=afterFirstEmptyReceipt(d1.database,async()=>{
  winnerResult=await call(token,tool,args);console.info('U8 winner accepted',action,!(winnerResult as {isError?:boolean}).isError);
  if(action==='comment') await call(token,'ledger_entry_correct',{operationId:'parent-changed',entryId:original.id,expectedVersion:1,entry:input});
 });
 const result=await call(token,tool,args,overriddenFetch({DB:race,OAUTH_KV:kv.namespace}));
 expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(result).toEqual(winnerResult);
 expect(d1.calls()+kv.calls()).toBeLessThanOrEqual(50);
 expect(await env.DB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id=?").bind('budget-race-'+action).first('n')).toBe(1);
 expect(await env.DB.prepare("SELECT count(*) n FROM audit_events WHERE operation_id=?").bind('budget-race-'+action).first('n')).toBe(1);
 console.info(`U8 concurrent ${action} combined D1+KV`,{d1:d1.calls(),kv:kv.calls(),combined:d1.calls()+kv.calls()});
});
