import {beforeEach,expect,it} from 'vitest';
import {LedgerService} from '../src/ledger/service';
import {D1LedgerRepository} from '../src/ledger/d1-repository';
import {bill,beforeBatch,ledgerDB,ledgerFixture} from './ledger-fixtures';
let context:Awaited<ReturnType<typeof ledgerFixture>>;
beforeEach(async()=>{context=await ledgerFixture();});
const service=(db=ledgerDB)=>new LedgerService(new D1LedgerRepository(db));
it('attributes immutable comments to current proof, replays once and leaves money/version unchanged even on void entries',async()=>{
 const a=await service().createExpense(context('comment-original'),bill()); await service().voidEntry(context('comment-void',1),a.id);
 const before=await ledgerDB.prepare("SELECT revision FROM ledger_financial_revisions WHERE household_id='home'").first('revision');
 const cmd={operationId:'comment-add',action:'comment' as const,entryId:a.id,expectedVersion:2,text:'Receipt clarified'};
 const c=await service().execute(context('comment-add'),cmd); expect(c).toMatchObject({entryId:a.id,observedVersion:2,authorId:'local-owner',text:cmd.text});
 expect(await service().execute(context('comment-add'),cmd)).toEqual(c);
 expect((await service().getEntry(context('comment-read'),a.id)).version).toBe(2);
 expect(await ledgerDB.prepare("SELECT revision FROM ledger_financial_revisions WHERE household_id='home'").first('revision')).toBe(before);
 expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_comments WHERE entry_id=?').bind(a.id).first('n')).toBe(1);
 await expect(ledgerDB.prepare("UPDATE ledger_comments SET text='changed' WHERE entry_id=?").bind(a.id).run()).rejects.toThrow();
 await expect(service().execute(context('comment-forged'),{...cmd,operationId:'comment-forged',authorId:'ledger-b'} as typeof cmd)).rejects.toMatchObject({status:400});
 await expect(service().execute(context('comment-stale'),{...cmd,operationId:'comment-stale',expectedVersion:1})).rejects.toMatchObject({status:409});
});
it('atomically rechecks parent version and current commenting authority',async()=>{
 const a=await service().createExpense(context('comment-race-original'),bill());
 const db=beforeBatch(ledgerDB,()=>service().correctExpense(context('comment-race-correct',1),a.id,bill(120)));
 await expect(service(db).execute(context('comment-race'),{operationId:'comment-race',action:'comment',entryId:a.id,expectedVersion:1,text:'Stale note'})).rejects.toMatchObject({status:409});
 const revoked=beforeBatch(ledgerDB,()=>ledgerDB.prepare("UPDATE members SET role='viewer' WHERE id='local-owner'").run());
 await expect(service(revoked).execute(context('comment-revoked'),{operationId:'comment-revoked',action:'comment',entryId:a.id,expectedVersion:2,text:'No access'})).rejects.toMatchObject({status:403});
 expect(await ledgerDB.prepare('SELECT count(*) n FROM ledger_comments WHERE entry_id=?').bind(a.id).first('n')).toBe(0);
});
it('binds text and observed version to the comment receipt and refuses disclosure after authority loss',async()=>{
 const a=await service().createExpense(context('comment-replay-original'),bill());
 const cmd={operationId:'comment-replay',action:'comment' as const,entryId:a.id,expectedVersion:1,text:'One explanation'};
 const {countedD1}=await import('./d1-budget');
 for(let i=0;i<2;i++){const counted=countedD1(ledgerDB);await new LedgerService(new D1LedgerRepository(counted.database)).execute(context(cmd.operationId),cmd);expect(counted.calls()).toBeLessThanOrEqual(50);}
 await expect(service().execute(context(cmd.operationId),{...cmd,text:'Changed explanation'})).rejects.toMatchObject({status:409});
 await ledgerDB.prepare("UPDATE members SET role='viewer' WHERE id='local-owner'").run();
 await expect(service().execute(context(cmd.operationId),cmd)).rejects.toMatchObject({status:403});
});
