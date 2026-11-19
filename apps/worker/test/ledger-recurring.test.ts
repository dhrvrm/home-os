import {beforeEach,expect,it} from 'vitest';
import {LedgerService} from '../src/ledger/service';
import {D1LedgerRepository} from '../src/ledger/d1-repository';
import {ExpenseService} from '../src/expenses/catalog/service';
import {D1ExpenseRepository} from '../src/expenses/catalog/d1-repository';
import type {LedgerCommand,LedgerEntry} from '../src/ledger/model';
import {bill,beforeBatch,ledgerDB,ledgerFixture} from './ledger-fixtures';
let context:Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async()=>{context=await ledgerFixture();});
const service=(db=ledgerDB)=>new LedgerService(new D1LedgerRepository(db));
const rules=()=>new ExpenseService(new D1ExpenseRepository(ledgerDB));
const rule=(anchorDate='2026-01-31',unit:'month'|'year'='month')=>rules().createRule(context(crypto.randomUUID()),{name:'Rent',amountMinor:100,currency:'INR',cadence:{unit,interval:1,anchorDate},participants:[{memberId:'ledger-b'},{memberId:'local-owner'}]});
const post=(id:string,op:string,period=0,expectedRuleVersion=1): Extract<LedgerCommand,{action:'post'}>=>({operationId:op,action:'post',ruleId:id,expectedRuleVersion,period,date:'2026-11-19',payers:[{memberId:'local-owner',amountMinor:100}]});
const run=(cmd:Extract<LedgerCommand,{action:'post'}>)=>service().execute(context(cmd.operationId),cmd) as Promise<LedgerEntry>;
it('normalizes monthly/yearly periods from the original anchor without drift',async()=>{
 const r=await rule(); const feb=await run(post(r.id,'post-feb',1)),mar=await run(post(r.id,'post-mar',2));
 expect(feb.source).toMatchObject({periodStart:'2026-02-28',periodEnd:'2026-03-31'});expect(mar.source).toMatchObject({periodStart:'2026-03-31',periodEnd:'2026-04-30'});
 const leap=await rule('2024-02-29','year'); const next=await run(post(leap.id,'post-year',1));expect(next.source).toMatchObject({periodStart:'2025-02-28',periodEnd:'2026-02-28'});
 await expect(run(post(r.id,'post-overflow',Number.MAX_SAFE_INTEGER))).rejects.toMatchObject({status:400});
});
it('retains source identity forever across concurrent operation IDs, rule versions, void and correction',async()=>{
 const r=await rule(); const results=await Promise.allSettled([run(post(r.id,'post-race-a')),run(post(r.id,'post-race-b'))]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1); const a=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<LedgerEntry>).value;
 await rules().updateRule(context('post-rule-edit',1),r.id,{name:'New rent',cadence:{unit:'month',interval:2,anchorDate:'2026-01-31'},participants:[{memberId:'ledger-b',override:{kind:'fixed',amountMinor:80}},{memberId:'local-owner'}]});
 expect(a.source!.snapshot.shares).toEqual([{memberId:'ledger-b',amountMinor:50},{memberId:'local-owner',amountMinor:50}]);
 expect((await service().getEntry(context('post-read'),a.id)).source).toEqual(a.source);
 await service().voidEntry(context('post-void',1),a.id);
 await expect(run(post(r.id,'post-duplicate-new-version',0,2))).rejects.toMatchObject({status:409});
 await expect(service().correctExpense(context('post-correct-void',2),a.id,bill(120))).rejects.toMatchObject({status:400});
 await service().restoreEntry(context('post-restore',2),a.id);
 const corrected=await service().correctExpense(context('post-correct-restored',3),a.id,bill(120));expect(corrected.source).toEqual(a.source);
 expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_sources WHERE rule_id=?').bind(r.id).first('n')).toBe(1);
});
it.each(['version','archive','membership'])('rechecks changed %s at the accepting batch',async(kind)=>{
 const r=await rule();const db=beforeBatch(ledgerDB,()=>kind==='membership'?ledgerDB.prepare("UPDATE members SET archived_at=CURRENT_TIMESTAMP WHERE id='ledger-b'").run():kind==='archive'?rules().archiveRule(context('post-race-archive',1),r.id):rules().updateRule(context('post-race-version',1),r.id,{name:'Changed'}));
 const cmd=post(r.id,`post-refuse-${kind}`); await expect(service(db).execute(context(cmd.operationId),cmd)).rejects.toMatchObject({status:400});
 expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_sources WHERE rule_id=?').bind(r.id).first('n')).toBe(0);
});
it('replays accepted postings after rule archival, preserves old shares and bounds success/refusal requests',async()=>{
 const r=await rule();const cmd=post(r.id,'post-replay');const {countedD1}=await import('./d1-budget');
 const counted=countedD1(ledgerDB);const a=await new LedgerService(new D1LedgerRepository(counted.database)).execute(context(cmd.operationId),cmd);expect(counted.calls()).toBeLessThanOrEqual(50);
 await rules().archiveRule(context('post-replay-archive',1),r.id);expect(await run(cmd)).toEqual(a);
 const refused=countedD1(ledgerDB);await expect(new LedgerService(new D1LedgerRepository(refused.database)).execute(context('post-archived-refuse'),post(r.id,'post-archived-refuse',1,2))).rejects.toMatchObject({status:400});expect(refused.calls()).toBeLessThanOrEqual(50);
});
