import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { D1ExpenseRepository } from '../expenses/catalog/d1-repository';
import { ExpenseService } from '../expenses/catalog/service';
import { strictCreateExpenseInput as createExpenseInput, strictUpdateExpenseInput as updateExpenseInput } from '../expenses/catalog/validation';
import { pageInput } from '../inventory/validation';
import { mutationInput, registerTool, subjectId, versionInput, type ToolContext } from './results';
export function registerExpenseTools(server: McpServer, context: ToolContext) {
  const service = new ExpenseService(new D1ExpenseRepository(context.env.DB)), household = context.authority.householdId;
  registerTool(server, context, 'expenses_list', 'Page recurring expense rules with resolved shares. These are rules, not payments or debts.', pageInput.extend({ archived: z.enum(['exclude','only','include']).default('exclude') }), true, async input => service.listRulesPage(household, input, input));
  registerTool(server, context, 'expenses_get', 'Get a recurring expense rule, shares and inactive-participant attention.', z.object({ ruleId: subjectId }), true, async input => ({ rule: await service.getRule(household, input.ruleId) }));
  registerTool(server, context, 'expenses_create', 'Create a recurring expense rule and validate its exact minor-unit split.', createExpenseInput.extend(mutationInput.shape).extend({ id: subjectId.optional() }), false, async ({ operationId: _, ...input }, command) => ({ status: 'accepted', rule: await service.createRule(command, input) }));
  registerTool(server, context, 'expenses_update', 'Revise a recurring rule at the observed version.', updateExpenseInput.extend(versionInput.shape).extend({ ruleId: subjectId }), false, async ({ ruleId, operationId: _, expectedVersion: __, ...input }, command) => ({ status: 'accepted', rule: await service.updateRule(command, ruleId, input) }));
  for (const action of ['expenses_archive', 'expenses_restore'] as const) registerTool(server, context, action, 'Archive or restore a recurring rule without recording a payment.', versionInput.extend({ ruleId: subjectId }), false, async (input, command) => ({ status: 'accepted', rule: action === 'expenses_archive' ? await service.archiveRule(command, input.ruleId) : await service.restoreRule(command, input.ruleId) }));
}
