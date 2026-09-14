const BASIS_POINTS_TOTAL = 10_000;

export type SplitOverride =
  | { kind: "fixed"; amountMinor: number }
  | { kind: "percent"; basisPoints: number };

export interface SplitParticipant {
  memberId: string;
  override?: SplitOverride;
}

export interface SplitRequest {
  totalMinor: number;
  minorUnit: number;
  participants: SplitParticipant[];
}

export type SplitFailureReason =
  | "no_participants"
  | "overrides_exceed_total"
  | "unassigned_remainder"
  | "invalid_override";

export type SplitResult =
  | { ok: true; shares: Array<{ memberId: string; amountMinor: number }> }
  | { ok: false; reason: SplitFailureReason };

export function resolveShares(request: SplitRequest): SplitResult {
  const participants = request.participants;
  if (participants.length === 0) return { ok: false, reason: "no_participants" };
  if (participants.some((participant) => !isValidOverride(participant.override))) {
    return { ok: false, reason: "invalid_override" };
  }

  const amounts = new Array<number>(participants.length).fill(0);

  let fixedTotal = 0;
  for (const [index, participant] of participants.entries()) {
    if (participant.override?.kind !== "fixed") continue;
    amounts[index] = participant.override.amountMinor;
    fixedTotal += participant.override.amountMinor;
  }
  if (fixedTotal > request.totalMinor) return { ok: false, reason: "overrides_exceed_total" };

  const percentTotal = assignPercentages(request.totalMinor, participants, amounts);
  if (fixedTotal + percentTotal > request.totalMinor) return { ok: false, reason: "overrides_exceed_total" };

  const remainder = request.totalMinor - fixedTotal - percentTotal;
  const equalIndexes = participants.flatMap((participant, index) => (participant.override ? [] : [index]));
  if (equalIndexes.length === 0) {
    return remainder === 0 ? shares(participants, amounts) : { ok: false, reason: "unassigned_remainder" };
  }

  const base = Math.floor(remainder / equalIndexes.length);
  const leftover = remainder - base * equalIndexes.length;
  for (const [position, index] of equalIndexes.entries()) {
    amounts[index] = base + (position < leftover ? 1 : 0);
  }
  return shares(participants, amounts);
}

/**
 * Percentages are taken from the total, so their exact values rarely land on whole minor
 * units. Each floor is assigned first and the collective shortfall is handed out by largest
 * fractional remainder — ties to the earlier participant — so every environment resolving
 * the same rule reaches the same answer.
 */
function assignPercentages(
  totalMinor: number,
  participants: SplitParticipant[],
  amounts: number[],
): number {
  const scaled = participants.flatMap((participant, index) =>
    participant.override?.kind === "percent"
      ? [{ index, numerator: totalMinor * participant.override.basisPoints }]
      : [],
  );
  if (scaled.length === 0) return 0;

  let assigned = 0;
  let numeratorTotal = 0;
  for (const entry of scaled) {
    const share = Math.floor(entry.numerator / BASIS_POINTS_TOTAL);
    amounts[entry.index] = share;
    assigned += share;
    numeratorTotal += entry.numerator;
  }

  const target = Math.floor(numeratorTotal / BASIS_POINTS_TOTAL);
  const ranked = [...scaled].sort(
    (left, right) =>
      (right.numerator % BASIS_POINTS_TOTAL) - (left.numerator % BASIS_POINTS_TOTAL) ||
      left.index - right.index,
  );
  for (let rank = 0; rank < target - assigned; rank += 1) {
    amounts[ranked[rank]!.index] += 1;
  }
  return target;
}

function isValidOverride(override: SplitOverride | undefined): boolean {
  if (!override) return true;
  if (override.kind === "fixed") {
    return Number.isSafeInteger(override.amountMinor) && override.amountMinor >= 0;
  }
  return (
    Number.isSafeInteger(override.basisPoints) &&
    override.basisPoints >= 1 &&
    override.basisPoints <= BASIS_POINTS_TOTAL
  );
}

function shares(participants: SplitParticipant[], amounts: number[]): SplitResult {
  return {
    ok: true,
    shares: participants.map((participant, index) => ({
      memberId: participant.memberId,
      amountMinor: amounts[index]!,
    })),
  };
}
