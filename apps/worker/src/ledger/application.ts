import { z } from 'zod';
import { assertAuthority } from '../auth/authority';
import type { Env } from '../env';
import type { CommandContext } from '../platform/context';
import { resolveExpense } from './allocation';
import { D1LedgerRepository } from './d1-repository';
import { D1LedgerQueryRepository } from './d1-query-repository';
import { LedgerQueries } from './queries';
import { parseQuery } from './query-validation';
import { LedgerService } from './service';
import { expenseInput, ledgerCommandInput, ledgerId } from './validation';

const postingFields = ledgerCommandInput.options[5].shape;
const rulePreviewInput = z.object({ kind: z.literal('rule-posting'), ruleId: ledgerId, expectedRuleVersion: postingFields.expectedRuleVersion, period: postingFields.period }).strict();
export const ledgerPreviewInput = z.union([expenseInput, rulePreviewInput]);
/** Both transports use current read admission around calculation/current recurring lookup. */
export async function previewLedger(env: Env, command: CommandContext, raw: unknown) {
  await assertAuthority(env.DB, command, 'ledger_get');
  try {
    const input = parseQuery(ledgerPreviewInput, raw);
    return input.kind === 'rule-posting'
      ? { source: await new D1LedgerRepository(env.DB).postingBasis(command.householdId, input.ruleId, input.expectedRuleVersion, input.period) }
      : { allocation: resolveExpense(input) };
  } finally { await assertAuthority(env.DB, command, 'ledger_get'); }
}
export function ledgerQueries(env: Env) { return new LedgerQueries(new D1LedgerQueryRepository(env.DB), env.HOMEOS_PASSWORD_PEPPER ?? ''); }
export function ledgerService(env: Env) { return new LedgerService(new D1LedgerRepository(env.DB)); }
