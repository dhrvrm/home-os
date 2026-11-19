import { z } from 'zod';
import { ValidationError } from '../platform/errors';
import { calendarDate, currencyInput, ledgerId } from './validation';

const page = { limit: z.number().int().min(1).max(50).default(25), cursor: z.string().min(1).max(4096).optional() };
const scope = {
  from: calendarDate.optional(), to: calendarDate.optional(), currency: currencyInput.optional(), memberId: ledgerId.optional(),
  category: z.string().trim().max(200).optional(), search: z.string().trim().max(160).optional(),
};
const dates = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
export const entryQueryInput = z.object({ ...scope, ...page, lifecycle: z.enum(['effective', 'void', 'all']).default('effective'), kind: z.enum(['expense', 'refund', 'payment']).optional() }).strict().refine(dates, 'The end date must follow the start date');
export const balanceQueryInput = z.object({ ...page, currency: currencyInput.optional(), memberId: ledgerId.optional() }).strict();
export const repaymentQueryInput = z.object({ ...page, currency: currencyInput.optional() }).strict();
export const summaryQueryInput = z.object({ ...scope, ...page, groupBy: z.enum(['month', 'category']).default('month') }).strict().refine(dates, 'The end date must follow the start date');
export const statementQueryInput = z.object({ ...page, memberId: ledgerId, currency: currencyInput, from: calendarDate.optional(), to: calendarDate.optional() }).strict().refine(dates, 'The end date must follow the start date');
export const exportQueryInput = statementQueryInput.safeExtend({ format: z.enum(['csv', 'json']).default('json') });
export const ledgerPageInput = z.object(page).strict();
export type EntryQuery = z.infer<typeof entryQueryInput>;
export type BalanceQuery = z.infer<typeof balanceQueryInput>;
export type RepaymentQuery = z.infer<typeof repaymentQueryInput>;
export type SummaryQuery = z.infer<typeof summaryQueryInput>;
export type StatementQuery = z.infer<typeof statementQueryInput>;
export type ExportQuery = z.infer<typeof exportQueryInput>;
export function parseQuery<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError('query', result.error.issues[0]!.message);
  return result.data;
}
