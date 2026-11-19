import { beforeEach, expect, it } from 'vitest';
import { LedgerService } from '../src/ledger/service';
import { D1LedgerRepository } from '../src/ledger/d1-repository';
import type { LedgerCommand, LedgerEntry, PaymentInput, RefundInput } from '../src/ledger/model';
import { bill, beforeBatch, ledgerDB, ledgerFixture } from './ledger-fixtures';
let context: Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async () => { context = await ledgerFixture(); });
const service = (db = ledgerDB) => new LedgerService(new D1LedgerRepository(db));
const credit = (id: string, amount = 60): RefundInput => ({kind:'refund',expenseId:id,date:'2026-11-19',description:'Returned',currency:'INR',totalMinor:amount,payers:[{memberId:'local-owner',amountMinor:amount}],shares:[{memberId:'ledger-b',amountMinor:amount}]});
const payment = (amount = 70): PaymentInput => ({kind:'payment',date:'2026-11-19',currency:'INR',totalMinor:amount,senderId:'ledger-b',receiverId:'local-owner',method:'Cash'});
const run = (op:string, command: Omit<Extract<LedgerCommand,{action:'create'}>,'operationId'>) => service().execute(context(op),{operationId:op,...command}) as Promise<LedgerEntry>;
const original = () => service().createExpense(context(crypto.randomUUID()),bill(100,{allocation:{kind:'split',split:{mode:'exact',participants:[{memberId:'ledger-b',kind:'fixed',amountMinor:100}]}}}));
it('accepts only one concurrent credit within overall capacity and preserves transactional refusal',async()=>{
 const a=await original(); const results=await Promise.allSettled([run('credit-race-a',{action:'create',entry:credit(a.id)}),run('credit-race-b',{action:'create',entry:credit(a.id)})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(await ledgerDB.prepare("SELECT count(*) n FROM ledger_entries WHERE expense_id=?").bind(a.id).first('n')).toBe(1);
 expect(await ledgerDB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id IN ('credit-race-a','credit-race-b')").first('n')).toBe(1);
 expect(await ledgerDB.prepare('SELECT count(*) n FROM mutation_guards').first('n')).toBe(0);
});
it('rechecks original reductions, void, per-person caps and credit restore against current facts',async()=>{
 const a=await original(); const c=await run('credit-life',{action:'create',entry:credit(a.id)});
 const reduce=bill(50,{allocation:{kind:'split',split:{mode:'exact',participants:[{memberId:'ledger-b',kind:'fixed',amountMinor:50}]}}});
 await expect(service().correctExpense(context('credit-reduce',1),a.id,reduce)).rejects.toMatchObject({status:400});
 await expect(service().voidEntry(context('credit-original-void',1),a.id)).rejects.toMatchObject({status:400});
 await expect(run('credit-wrong-person',{action:'create',entry:{...credit(a.id,10),shares:[{memberId:'local-owner',amountMinor:10}]}})).rejects.toMatchObject({status:400});
 await service().voidEntry(context('credit-void',1),c.id); await service().correctExpense(context('credit-reduce-ok',1),a.id,reduce);
 await expect(service().restoreEntry(context('credit-restore',2),c.id)).rejects.toMatchObject({status:400});
 await service().voidEntry(context('credit-original-void-ok',2),a.id);
 await expect(service().restoreEntry(context('credit-restore-original-void',2),c.id)).rejects.toMatchObject({status:400});
});
it('guards per-person capacity and concurrent original edits at acceptance',async()=>{
 const a=await service().createExpense(context('credit-sides-original'),bill(100));
 const half={...credit(a.id,40),shares:[{memberId:'ledger-b',amountMinor:40}]};
 await run('credit-side-first',{action:'create',entry:half});
 await expect(run('credit-side-second',{action:'create',entry:{...half,totalMinor:20,payers:[{memberId:'local-owner',amountMinor:20}],shares:[{memberId:'ledger-b',amountMinor:20}]}})).rejects.toMatchObject({status:400});
 const db=beforeBatch(ledgerDB,()=>service().correctExpense(context('credit-race-reduction',1),a.id,bill(90)));
 await expect(new LedgerService(new D1LedgerRepository(db)).execute(context('credit-race-current'),{operationId:'credit-race-current',action:'create',entry:{...credit(a.id,20),shares:[{memberId:'ledger-b',amountMinor:20}]}})).rejects.toMatchObject({status:400});
});
it('payments keep sender-positive signs through correction, void, restore and authorized replay',async()=>{
 const a=await original(); const p=await run('payment-create',{action:'create',entry:payment()});
 expect(await run('payment-create',{action:'create',entry:payment()})).toEqual(p);
 const net=async()=> (await service().repository.currentEffects('home')).filter(e=>[a.id,p.id].includes(e.entryId)&&e.memberId==='ledger-b').reduce((n,e)=>n+e.amountMinor,0);
 expect(await net()).toBe(-30);
 await service().execute(context('payment-correct'),{operationId:'payment-correct',action:'correct',entryId:p.id,expectedVersion:1,entry:payment(120)}); expect(await net()).toBe(20);
 await service().voidEntry(context('payment-void',2),p.id); expect(await net()).toBe(-100);
 await service().restoreEntry(context('payment-restore',3),p.id); expect(await net()).toBe(20);
 expect((await service().repository.history('home',p.id))[1]!.transitions.filter(e=>e.memberId==='ledger-b').map(e=>e.amountMinor)).toEqual([-70,120]);
 await expect(service().correctExpense(context('payment-kind-change',4),p.id,bill())).rejects.toMatchObject({status:400});
});
it('allows known departed payment parties and refuses foreign people, self payments and acceptance-time authority loss',async()=>{
 await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-b'").run();
 await expect(run('payment-departed',{action:'create',entry:payment()})).resolves.toMatchObject({intent:payment()});
 await expect(run('payment-foreign',{action:'create',entry:{...payment(),receiverId:'foreign-person'}})).rejects.toMatchObject({status:400});
 await expect(run('payment-self',{action:'create',entry:{...payment(),receiverId:'ledger-b'}})).rejects.toMatchObject({status:400});
 const db=beforeBatch(ledgerDB,()=>ledgerDB.prepare("UPDATE members SET role='viewer' WHERE id='local-owner'").run());
 await expect(service(db).execute(context('payment-revoked'),{operationId:'payment-revoked',action:'create',entry:payment()})).rejects.toMatchObject({status:403});
 expect(await ledgerDB.prepare("SELECT count(*) n FROM household_command_receipts WHERE operation_id='payment-revoked'").first('n')).toBe(0);
});
it('replaces refund effects on correction, preserves linkage/currency and restores departed historical people',async()=>{
 const a=await original(); const c=await run('credit-effects',{action:'create',entry:credit(a.id,30)});
 const net=async()=> (await service().repository.currentEffects('home')).filter(e=>[a.id,c.id].includes(e.entryId)&&e.memberId==='local-owner').reduce((n,e)=>n+e.amountMinor,0);
 expect(await net()).toBe(70);
 await service().correctEntry(context('credit-effects-correct',1),c.id,credit(a.id,50));expect(await net()).toBe(50);
 await expect(service().correctEntry(context('credit-effects-too-large',2),c.id,credit(a.id,101))).rejects.toMatchObject({status:400});
 await expect(service().correctEntry(context('credit-effects-currency',2),c.id,{...credit(a.id,50),currency:'USD'})).rejects.toMatchObject({status:400});
 const other=await original();await expect(service().correctEntry(context('credit-effects-link',2),c.id,credit(other.id,50))).rejects.toMatchObject({status:400});
 await ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-b'").run();
 await service().voidEntry(context('credit-effects-void',2),c.id);expect(await net()).toBe(100);
 await service().restoreEntry(context('credit-effects-restore',3),c.id);expect(await net()).toBe(50);
 const history=await service().repository.history('home',c.id);
 expect(history[1]!.transitions.filter(e=>e.memberId==='local-owner').map(e=>e.amountMinor)).toEqual([30,-50]);
});
it('refuses original reallocations, removed named credit people and currency changes that break current active caps',async()=>{
 const a=await service().createExpense(context('credit-person-original'),bill(100,{payers:[{memberId:'local-owner',amountMinor:40},{memberId:'ledger-c',amountMinor:60}]}));
 const c={...credit(a.id,40),payers:[{memberId:'local-owner',amountMinor:40}]};await run('credit-person-first',{action:'create',entry:c});
 await expect(service().correctExpense(context('credit-person-payer-reduce',1),a.id,bill(100,{payers:[{memberId:'local-owner',amountMinor:30},{memberId:'ledger-c',amountMinor:70}]}))).rejects.toMatchObject({status:400});
 await expect(service().correctExpense(context('credit-person-share-remove',1),a.id,bill(100,{payers:[{memberId:'local-owner',amountMinor:40},{memberId:'ledger-c',amountMinor:60}],allocation:{kind:'split',split:{mode:'equal',participants:[{memberId:'local-owner',kind:'equal'},{memberId:'ledger-c',kind:'equal'}]}}}))).rejects.toMatchObject({status:400});
 await expect(service().correctExpense(context('credit-person-currency',1),a.id,bill(100,{currency:'USD'}))).rejects.toMatchObject({status:400});
});
it('refuses actual cross-household payment parties and credit originals',async()=>{
 await ledgerDB.batch([
  ledgerDB.prepare("INSERT INTO households(id,name,created_at,updated_at) VALUES('payment-other-home','Other',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
  ledgerDB.prepare("INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES('payment-foreign-person','payment-other-home','Foreign','member',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
 ]);
 await expect(service().createPayment(context('payment-actual-foreign'),{...payment(),receiverId:'payment-foreign-person'})).rejects.toMatchObject({status:400});
 await expect(service().createRefund(context('credit-unknown-original'),credit('other-household-entry'))).rejects.toMatchObject({status:400});
});
it('keeps accepted credit/payment retry acknowledgement and refused transitions within the D1 request budget',async()=>{
 const {countedD1}=await import('./d1-budget');const a=await original();
 const submit=async(op:string,input:RefundInput|PaymentInput,expectedStatus?:number)=>{
  const counted=countedD1(ledgerDB);const call=new LedgerService(new D1LedgerRepository(counted.database)).execute(context(op),{operationId:op,action:'create',entry:input});
  if(expectedStatus) await expect(call).rejects.toMatchObject({status:expectedStatus});else await call;
  expect(counted.calls()).toBeLessThanOrEqual(50);
 };
 await submit('budget-credit',credit(a.id));await submit('budget-credit',credit(a.id));await submit('budget-credit-refusal',credit(a.id),400);
 await submit('budget-payment',payment());await submit('budget-payment',payment());await submit('budget-payment-refusal',{...payment(),receiverId:'not-here'},400);
});
it('rechecks an original void between credit preparation and acceptance',async()=>{
 const a=await original();const db=beforeBatch(ledgerDB,()=>service().voidEntry(context('credit-race-original-void',1),a.id));
 await expect(service(db).createRefund(context('credit-race-after-void'),credit(a.id,30))).rejects.toMatchObject({status:400});
 expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_entries WHERE expense_id=?').bind(a.id).first('n')).toBe(0);
});
it('replaces payment currency and both parties with complete reversal and replacement provenance',async()=>{
 const p=await service().createPayment(context('payment-fx-original'),payment(25));
 const next:PaymentInput={...payment(40),currency:'USD',senderId:'ledger-c',receiverId:'ledger-b'};
 await service().correctEntry(context('payment-fx-correct',1),p.id,next);
 expect((await service().repository.currentEffects('home')).filter(e=>e.entryId===p.id).map(e=>[e.memberId,e.currency,e.amountMinor])).toEqual([['ledger-b','USD',-40],['ledger-c','USD',40]]);
 const history=await service().repository.history('home',p.id);
 expect(history[1]!.transitions.map(e=>[e.effectKind,e.memberId,e.currency,e.amountMinor])).toEqual([['reversal','ledger-b','INR',-25],['reversal','local-owner','INR',25],['replacement','ledger-b','USD',-40],['replacement','ledger-c','USD',40]]);
});
