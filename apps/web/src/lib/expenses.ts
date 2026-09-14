const BASIS_POINTS_TOTAL = 10_000;
const LOCALE = "en-IN";

export type CadenceUnit = "day" | "week" | "month" | "year";

export interface Cadence {
  unit: CadenceUnit;
  interval: number;
  anchorDate: string;
}

export type SplitOverride =
  | { kind: "fixed"; amountMinor: number }
  | { kind: "percent"; basisPoints: number };

export interface ExpenseParticipant {
  memberId: string;
  override: SplitOverride | null;
  shareMinor: number;
  memberActive: boolean;
}

export interface ExpenseRule {
  id: string;
  householdId: string;
  name: string;
  amountMinor: number;
  currency: string;
  cadence: Cadence;
  participants: ExpenseParticipant[];
  needsAttention: boolean;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseParticipantInput {
  memberId: string;
  override?: SplitOverride | null;
}

export interface CreateExpenseInput {
  id?: string;
  name: string;
  amountMinor: number;
  currency?: string;
  cadence: Cadence;
  participants: ExpenseParticipantInput[];
}

export interface UpdateExpenseInput {
  name?: string;
  amountMinor?: number;
  currency?: string;
  cadence?: Cadence;
  participants?: ExpenseParticipantInput[];
}

export interface Member {
  id: string;
  name: string;
  active: boolean;
}

export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
};

export const DEFAULT_CURRENCY = "INR";

export interface SplitParticipant {
  memberId: string;
  override?: SplitOverride | null;
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

/**
 * Duplicate of the worker's share resolver. It exists so the dialog can predict what the
 * server will persist; any divergence between the two makes the preview a lie.
 */
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

function isValidOverride(override: SplitOverride | null | undefined): boolean {
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

export function minorUnitOf(currency: string): number {
  return CURRENCY_MINOR_UNITS[currency] ?? 2;
}

export function formatMinorAmount(amountMinor: number, currency: string): string {
  const minorUnit = minorUnitOf(currency);
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  }).format(majorUnits(amountMinor, minorUnit));
}

/** Shares stay integers; the decimal point is placed textually so no float scaling is applied. */
function majorUnits(amountMinor: number, minorUnit: number): number {
  if (minorUnit === 0) return amountMinor;
  const sign = amountMinor < 0 ? "-" : "";
  const digits = String(Math.abs(amountMinor)).padStart(minorUnit + 1, "0");
  return Number(`${sign}${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`);
}

/** Parses a major-unit entry into integer minor units, or null when it is not a valid amount. */
export function parseMinorAmount(value: string, currency: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;
  const minorUnit = minorUnitOf(currency);
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > minorUnit) return null;
  return Number(`${whole}${fraction.padEnd(minorUnit, "0")}`);
}

const PERCENT_DECIMALS = 2;

/** Parses a percentage entry (up to two decimals) into integer basis points, or null. */
export function parseBasisPoints(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d*)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > PERCENT_DECIMALS) return null;
  return Number(`${whole}${fraction.padEnd(PERCENT_DECIMALS, "0")}`);
}

export function formatBasisPoints(basisPoints: number): string {
  return (basisPoints / 100).toFixed(PERCENT_DECIMALS).replace(/\.?0+$/, "");
}

/** Renders integer minor units as a plain major-unit entry the amount inputs can hold. */
export function minorAmountInputValue(amountMinor: number, currency: string): string {
  const minorUnit = minorUnitOf(currency);
  if (minorUnit === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(minorUnit + 1, "0");
  return `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}`;
}

const CADENCE_NOUNS: Record<CadenceUnit, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

export function describeCadence(cadence: Cadence): string {
  const noun = CADENCE_NOUNS[cadence.unit];
  const every = cadence.interval === 1 ? noun : `${cadence.interval} ${noun}s`;
  return `Every ${every} from ${formatAnchorDate(cadence.anchorDate)}`;
}

function formatAnchorDate(anchorDate: string): string {
  const parsed = new Date(`${anchorDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return anchorDate;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

const SPLIT_FAILURE_MESSAGES: Record<SplitFailureReason, string> = {
  no_participants: "Add at least one participant to split this expense.",
  overrides_exceed_total: "The fixed and percentage shares add up to more than the total.",
  unassigned_remainder: "The shares do not add up to the total, and nobody is set to absorb the rest.",
  invalid_override: "One of the shares is not a valid amount or percentage.",
};

export function describeSplitFailure(reason: SplitFailureReason): string {
  return SPLIT_FAILURE_MESSAGES[reason];
}
