import { z } from "zod";
import { expenseRuleId } from "../expenses/catalog/validation";
import { MAX_ENTRY_MINOR, MAX_ITEMS, MAX_PARTICIPANTS, MAX_WEIGHT, parseQuantity } from "../../../../shared/ledger-money";
import { resolveExpense, validateRefundAllocation, assertContributions } from "./allocation";
import type { ExpenseInput, LedgerCommand, RefundInput } from "./model";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const ledgerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "Invalid identity");
const text = (maximum: number) => z.string().trim().min(1).refine(s => [...s].length <= maximum, `Must contain at most ${maximum} characters`);
const optionalText = (maximum: number) => z.string().trim().refine(s => [...s].length <= maximum, `Must contain at most ${maximum} characters`).optional();
const integer = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
export const moneyMinor = integer(1, MAX_ENTRY_MINOR);
const nonnegativeMinor = integer(0, MAX_ENTRY_MINOR);
export const currencyInput = z.enum(["INR", "USD", "EUR", "GBP", "JPY"]);
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !value.startsWith("0000-") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a real calendar date");
const personAmount = z.object({ memberId: ledgerId, amountMinor: nonnegativeMinor }).strict();
const contributions = z.array(personAmount).min(1).max(MAX_PARTICIPANTS);
const participant = z.discriminatedUnion("kind", [
  z.object({ memberId: ledgerId, kind: z.literal("equal") }).strict(),
  z.object({ memberId: ledgerId, kind: z.literal("fixed"), amountMinor: nonnegativeMinor }).strict(),
  z.object({ memberId: ledgerId, kind: z.literal("percent"), basisPoints: integer(0, 10000) }).strict(),
  // Normalized ratio units: 10,000 means one whole share, matching implicit equal.
  z.object({ memberId: ledgerId, kind: z.literal("weight"), weight: integer(1, MAX_WEIGHT) }).strict(),
]);
export const splitInput = z.object({ mode: z.enum(["equal", "exact", "percentage", "weighted", "mixed"]), participants: z.array(participant).min(1).max(MAX_PARTICIPANTS) }).strict();
const adjustment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amountMinor: nonnegativeMinor }).strict(),
  z.object({ kind: z.literal("percent"), basisPoints: integer(0, 10000) }).strict(),
]);
export const itemInput = z.object({
  label: text(160), unitPriceMinor: nonnegativeMinor,
  quantity: z.string().max(128).refine(s => parseQuantity(s) !== null, "Invalid quantity"), split: splitInput,
}).strict();
const itemizedAllocation = z.object({
  kind: z.literal("itemized"), participantOrder: z.array(ledgerId).min(1).max(MAX_PARTICIPANTS),
  items: z.array(itemInput).min(1).max(MAX_ITEMS), discount: adjustment.optional(), tax: adjustment.optional(), tip: adjustment.optional(),
}).strict();
function calculationIssue(context: z.RefinementCtx, run: () => unknown): void {
  try { run(); } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid financial intent" }); }
}
export const expenseInput = z.object({
  kind: z.literal("expense"), date: calendarDate, description: text(160), currency: currencyInput, totalMinor: moneyMinor,
  category: optionalText(200), notes: optionalText(2000), payers: contributions,
  allocation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("split"), split: splitInput }).strict(), itemizedAllocation]),
}).strict().superRefine((input, context) => calculationIssue(context, () => resolveExpense(input as ExpenseInput)));
export const refundInput = z.object({
  kind: z.literal("refund"), expenseId: ledgerId, date: calendarDate, description: text(160), currency: currencyInput,
  totalMinor: moneyMinor, notes: optionalText(2000), payers: contributions, shares: contributions,
}).strict().superRefine((input, context) => calculationIssue(context, () => validateRefundAllocation(input as RefundInput)));
export const paymentInput = z.object({
  kind: z.literal("payment"), date: calendarDate, currency: currencyInput, totalMinor: moneyMinor,
  senderId: ledgerId, receiverId: ledgerId, method: text(200), reference: optionalText(200), notes: optionalText(2000),
}).strict().refine(input => input.senderId !== input.receiverId, "Sender and receiver must be different people");
export const financialInput = z.discriminatedUnion("kind", [expenseInput, refundInput, paymentInput]);
const operationId = ledgerId;
const expectedVersion = integer(1, Number.MAX_SAFE_INTEGER);
export const createCommandInput = z.object({ operationId, action: z.literal("create"), entry: financialInput }).strict();
export const correctCommandInput = z.object({ operationId, action: z.literal("correct"), entryId: ledgerId, expectedVersion, entry: financialInput }).strict();
export const voidCommandInput = z.object({ operationId, action: z.literal("void"), entryId: ledgerId, expectedVersion }).strict();
export const restoreCommandInput = z.object({ operationId, action: z.literal("restore"), entryId: ledgerId, expectedVersion }).strict();
export const commentCommandInput = z.object({ operationId, action: z.literal("comment"), entryId: ledgerId, expectedVersion, text: text(2000) }).strict();
export const postCommandInput = z.object({ operationId, action: z.literal("post"), ruleId: expenseRuleId, expectedRuleVersion: expectedVersion,
    // An ordinal from the rule's original anchor; calendar range/cadence are acceptance checks.
    period: integer(0, Number.MAX_SAFE_INTEGER),
    date: calendarDate, payers: contributions, description: optionalText(160), category: optionalText(200), notes: optionalText(2000),
  }).strict().superRefine((input, context) => calculationIssue(context, () => {
    const total = input.payers.reduce((sum, p) => sum + BigInt(p.amountMinor), BigInt(0));
    assertContributions(input.payers, Number(total));
  }));
export const ledgerCommandInput = z.discriminatedUnion("action", [
  createCommandInput, correctCommandInput, voidCommandInput, restoreCommandInput, commentCommandInput, postCommandInput,
]);
/** HTTP/MCP callers must invoke before JSON.parse so escaped/multi-byte payloads are bounded. */
export function parseLedgerRequest(raw: string | Uint8Array): LedgerCommand {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new Error("Ledger requests must be at most 64 KiB");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return ledgerCommandInput.parse(JSON.parse(source)) as LedgerCommand;
}
