import { env } from 'cloudflare:workers';
import { digest } from '../src/auth/crypto';
import type { CommandContext } from '../src/platform/context';
import type { ExpenseInput } from '../src/ledger/model';
export const ledgerDB = (env as unknown as {
    DB: D1Database;
}).DB;
export async function ledgerFixture() {
    const hash = await digest('ledger-session');
    await ledgerDB.prepare("UPDATE members SET role=CASE WHEN id='local-owner' THEN 'owner' ELSE role END, archived_at=NULL WHERE id IN ('local-owner','ledger-b','ledger-c')").run();
    await ledgerDB.prepare("UPDATE auth_accounts SET credential_version=1 WHERE member_id='local-owner'").run();
    await ledgerDB.batch([
        ledgerDB.prepare("INSERT OR IGNORE INTO auth_accounts(member_id,email,password_hash,updated_at) VALUES('local-owner','ledger@test.test','fixture',CURRENT_TIMESTAMP)"),
        ledgerDB.prepare("INSERT OR IGNORE INTO auth_sessions(token_hash,member_id,credential_version,expires_at,created_at) VALUES(?,'local-owner',1,'2099-01-01T00:00:00Z',CURRENT_TIMESTAMP)").bind(hash),
        ledgerDB.prepare("INSERT OR IGNORE INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES('ledger-b','home','B','member',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('ledger-c','home','C','viewer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('ledger-owner','home','Other owner','owner',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    ]);
    await ledgerDB.prepare("INSERT OR IGNORE INTO auth_accounts(member_id,email,password_hash,updated_at) VALUES('ledger-owner','other@test.test','fixture',CURRENT_TIMESTAMP)").run();
    return (operationId: string, expectedVersion?: number): CommandContext => ({ householdId: 'home', actorId: 'local-owner', actorType: 'member', source: 'pwa', operationId, expectedVersion, authority: { householdId: 'home', memberId: 'local-owner', role: 'owner', proof: { kind: 'browser', tokenHash: hash, credentialVersion: 1 } } });
}
export function bill(totalMinor = 100, overrides: Partial<ExpenseInput> = {}): ExpenseInput { return { kind: 'expense', date: '2026-11-19', description: 'Dinner', currency: 'INR', totalMinor, payers: [{ memberId: 'local-owner', amountMinor: totalMinor }], allocation: { kind: 'split', split: { mode: 'equal', participants: [{ memberId: 'local-owner', kind: 'equal' }, { memberId: 'ledger-b', kind: 'equal' }] } }, ...overrides }; }
export function beforeBatch(database: D1Database, change: () => Promise<unknown>): D1Database { let done = false; return new Proxy(database, { get(target, key) { if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => { if (!done) {
            done = true;
            await change();
        } return target.batch(statements); }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }); }
