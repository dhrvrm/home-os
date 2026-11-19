import { assertInteger, assertMemberId, LedgerMoneyError, MAX_ENTRY_MINOR, MAX_PARTICIPANTS, resolveAllocation, resolveItemizedBill, type Share } from "../../../../shared/ledger-money";
import type { ExpenseInput, LedgerEffect, LedgerEntry, RefundInput, ResolvedExpense } from "./model";

export function assertContributions(shares: Share[], totalMinor: number): void {
  assertInteger(totalMinor, 1, MAX_ENTRY_MINOR, "totalMinor");
  if (shares.length < 1 || shares.length > MAX_PARTICIPANTS) throw new LedgerMoneyError("invalid_participants", "Choose 1 to 12 people");
  const ids = shares.map(s => assertMemberId(s.memberId));
  if (new Set(ids).size !== ids.length) throw new LedgerMoneyError("duplicate_participant", "Each person may occur only once");
  let total = BigInt(0);
  for (const share of shares) total += BigInt(assertInteger(share.amountMinor, 0, MAX_ENTRY_MINOR));
  if (total !== BigInt(totalMinor)) throw new LedgerMoneyError("contribution_total", "Contributions must equal the total");
}
export function assertParticipantUnion(payers: Share[], shares: Share[]): void {
  if (new Set([...payers, ...shares].map(p => p.memberId)).size > MAX_PARTICIPANTS) throw new LedgerMoneyError("invalid_participants", "Payers and beneficiaries together may include at most 12 people");
}
export function resolveExpense(input: ExpenseInput): ResolvedExpense {
  assertContributions(input.payers, input.totalMinor);
  const itemized = input.allocation.kind === "itemized" ? resolveItemizedBill(input.allocation) : undefined;
  if (itemized && itemized.totalMinor !== input.totalMinor) throw new LedgerMoneyError("itemized_total", "The stated total must match the itemized result");
  const shares = input.allocation.kind === "split" ? resolveAllocation(input.totalMinor, input.allocation.split) : itemized!.shares;
  assertParticipantUnion(input.payers, shares);
  return { totalMinor: input.totalMinor, payers: input.payers.map(p => ({ ...p })), shares, ...(itemized ? { itemized } : {}) };
}
/** Source effectiveness, currency and cumulative caps are checked at later acceptance. */
export function validateRefundAllocation(input: RefundInput): void {
  assertContributions(input.payers, input.totalMinor);
  assertContributions(input.shares, input.totalMinor);
  assertParticipantUnion(input.payers, input.shares);
}

/** Combine paid and allocated sides once; zero effects retain named participants. */
export function effects(entry: LedgerEntry, direction: 1 | -1 = 1): LedgerEffect[] {
    if (entry.intent.kind === 'payment') return [
      { entryId: entry.id, version: entry.version, memberId: entry.intent.senderId, currency: entry.intent.currency, amountMinor: entry.intent.totalMinor * direction },
      { entryId: entry.id, version: entry.version, memberId: entry.intent.receiverId, currency: entry.intent.currency, amountMinor: -entry.intent.totalMinor * direction },
    ];
    const sign = entry.intent.kind === 'refund' ? -direction : direction;
    const net = new Map<string, number>();
    for (const p of entry.payers)
        net.set(p.memberId, (net.get(p.memberId) ?? 0) + p.amountMinor);
    for (const p of entry.shares)
        net.set(p.memberId, (net.get(p.memberId) ?? 0) - p.amountMinor);
    return [...net].map(([memberId, amountMinor]) => ({ entryId: entry.id, version: entry.version, memberId, currency: entry.intent.currency, amountMinor: amountMinor * sign }));
}
