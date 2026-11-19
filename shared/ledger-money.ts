/** Exact, environment-neutral arithmetic for accepted ledger intent and browser previews. */
export const MAX_ENTRY_MINOR = 10_000_000_000;
export const MAX_AGGREGATE_MINOR = Number.MAX_SAFE_INTEGER;
export const MAX_PARTICIPANTS = 12;
export const MAX_ITEMS = 40;
/** Canonical ratio units: 10,000 = one whole share; 1 = 0.0001 share. */
export const WEIGHT_SCALE = 10_000;
export const MAX_WEIGHT = 100_000_000;
export const CURRENCY_MINOR_UNITS = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 } as const;
export type Currency = keyof typeof CURRENCY_MINOR_UNITS;
export type Share = { memberId: string; amountMinor: number };
export type SplitParticipant = { memberId: string } & (
  | { kind: "equal" }
  | { kind: "fixed"; amountMinor: number }
  | { kind: "percent"; basisPoints: number }
  | { kind: "weight"; /** Integer units of 0.0001 share; implicit equal uses WEIGHT_SCALE. */ weight: number }
);
export type SplitIntent = { mode: "equal" | "exact" | "percentage" | "weighted" | "mixed"; participants: SplitParticipant[] };
export type Adjustment = { kind: "fixed"; amountMinor: number } | { kind: "percent"; basisPoints: number };
export interface BillItem { label: string; unitPriceMinor: number; quantity: string; split: SplitIntent }
export interface ItemizedIntent { participantOrder: string[]; items: BillItem[]; discount?: Adjustment; tax?: Adjustment; tip?: Adjustment }
export interface ItemizedResult {
  subtotalMinor: number; discountMinor: number; discountedSubtotalMinor: number;
  taxMinor: number; tipMinor: number; totalMinor: number; shares: Share[];
  items: Array<{ label: string; quantity: string; unitPriceMinor: number; totalMinor: number; shares: Share[] }>;
  breakdown: Array<{ memberId: string; baseMinor: number; discountMinor: number; taxMinor: number; tipMinor: number; amountMinor: number }>;
}

export class LedgerMoneyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "LedgerMoneyError"; }
}
function refuse(code: string, message: string): never { throw new LedgerMoneyError(code, message); }
const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), BPS = BigInt(10000);
export function assertInteger(value: number, minimum: number, maximum: number, field = "amount"): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) refuse("invalid_amount", `${field} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
export function assertMemberId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) refuse("invalid_id", "Enter a valid member identity");
  return value;
}
function validateIds(ids: string[]): void {
  if (ids.length < 1 || ids.length > MAX_PARTICIPANTS) refuse("invalid_participants", "Choose between 1 and 12 people");
  ids.forEach(assertMemberId);
  if (new Set(ids).size !== ids.length) refuse("duplicate_participant", "Each person may occur only once");
}
function assertCurrency(currency: Currency): number {
  if (!Object.hasOwn(CURRENCY_MINOR_UNITS, currency)) refuse("invalid_currency", "Choose a supported currency");
  return CURRENCY_MINOR_UNITS[currency];
}

/** Quotas have one denominator; equal residuals always retain original array order. */
function quotas(numerators: bigint[], denominator: bigint, target: bigint): bigint[] {
  const amounts = numerators.map(n => n / denominator);
  const residual = target - amounts.reduce((sum, n) => sum + n, ZERO);
  const ranked = numerators.map((n, index) => ({ index, remainder: n % denominator })).sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < Number(residual); i++) amounts[ranked[i]!.index] = amounts[ranked[i]!.index]! + ONE;
  return amounts;
}
function apportion(total: bigint, weights: bigint[]): bigint[] {
  const basis = weights.reduce((sum, n) => sum + n, ZERO);
  if (basis === ZERO) {
    if (total > ZERO) refuse("zero_allocation_basis", "A positive adjustment needs a positive allocation basis");
    return weights.map(() => ZERO);
  }
  return quotas(weights.map(n => total * n), basis, total);
}
function allocate(totalMinor: number, split: SplitIntent, allowZero: boolean): Share[] {
  assertInteger(totalMinor, allowZero ? 0 : 1, MAX_ENTRY_MINOR, "totalMinor");
  validateIds(split.participants.map(p => p.memberId));
  const allowed: Record<SplitIntent["mode"], SplitParticipant["kind"][]> = { equal: ["equal"], exact: ["fixed"], percentage: ["percent"], weighted: ["weight"], mixed: ["equal", "weight", "fixed", "percent"] };
  if (!allowed[split.mode] || split.participants.some(p => !allowed[split.mode].includes(p.kind))) refuse("invalid_split", "Split mode and participant instructions must agree");
  const amounts = split.participants.map(() => ZERO);
  let fixed = ZERO;
  const percentages: Array<{ index: number; bps: bigint }> = [];
  const remainderPeople: Array<{ index: number; weight: bigint }> = [];
  split.participants.forEach((p, index) => {
    switch (p.kind) {
      case "fixed": amounts[index] = BigInt(assertInteger(p.amountMinor, 0, MAX_ENTRY_MINOR)); fixed += amounts[index]!; break;
      case "percent": percentages.push({ index, bps: BigInt(assertInteger(p.basisPoints, 0, 10000, "basisPoints")) }); break;
      case "weight": remainderPeople.push({ index, weight: BigInt(assertInteger(p.weight, 1, MAX_WEIGHT, "weight")) }); break;
      case "equal": remainderPeople.push({ index, weight: BigInt(WEIGHT_SCALE) }); break;
    }
  });
  const total = BigInt(totalMinor);
  const sumBps = percentages.reduce((sum, p) => sum + p.bps, ZERO);
  if (sumBps > BPS || (split.mode === "percentage" && sumBps !== BPS)) refuse("invalid_percentage_total", "Percentage-only shares must total 100%; combined percentages cannot exceed 100%");
  const percentTarget = total * sumBps / BPS;
  if (fixed + percentTarget > total) refuse("overrides_exceed_total", "Fixed and percentage shares exceed the total");
  const percentAmounts = quotas(percentages.map(p => total * p.bps), BPS, percentTarget);
  percentages.forEach((p, i) => { amounts[p.index] = percentAmounts[i]!; });
  const remainder = total - fixed - percentTarget;
  if (remainderPeople.length === 0 && remainder !== ZERO) refuse("unassigned_remainder", "The split must assign the whole total");
  if (remainderPeople.length > 0) {
    const rest = apportion(remainder, remainderPeople.map(p => p.weight));
    remainderPeople.forEach((p, i) => { amounts[p.index] = rest[i]!; });
  }
  return split.participants.map((p, i) => ({ memberId: p.memberId, amountMinor: Number(amounts[i]!) }));
}
export function resolveAllocation(totalMinor: number, split: SplitIntent): Share[] { return allocate(totalMinor, split, false); }

/** Decimal text is scaled as digits, never by floating multiplication. */
function parseScaled(text: string, precision: number, maximum: number): number | null {
  if (typeof text !== "string" || text.length > 128 || !/^\d+(?:\.\d+)?$/.test(text.trim())) return null;
  const [whole, fraction = ""] = text.trim().split(".");
  if (fraction.length > precision) return null;
  const value = BigInt(whole! + fraction.padEnd(precision, "0"));
  return value > BigInt(maximum) ? null : Number(value);
}
export function parseMoney(text: string, currency: Currency): number | null { return parseScaled(text, assertCurrency(currency), MAX_ENTRY_MINOR); }
export function parsePercentage(text: string): number | null { return parseScaled(text, 2, 10000); }
/** All decimal weights use the same 10,000 scale, preserving ratios. */
export function parseWeight(text: string): number | null {
  const value = parseScaled(text, 4, MAX_WEIGHT);
  return value === 0 ? null : value;
}
export function parseQuantity(text: string): number | null {
  const value = parseScaled(text, 3, 1_000_000_000);
  return value === 0 ? null : value;
}
function roundPositive(numerator: bigint, denominator: bigint): bigint {
  // Quotient/remainder rounding avoids doubling an already bounded intermediate.
  return numerator / denominator + (numerator % denominator >= denominator / TWO + denominator % TWO ? ONE : ZERO);
}
function adjustmentTotal(adjustment: Adjustment | undefined, basis: bigint): bigint {
  if (!adjustment) return ZERO;
  if (adjustment.kind === "fixed") return BigInt(assertInteger(adjustment.amountMinor, 0, MAX_ENTRY_MINOR));
  if (adjustment.kind !== "percent") refuse("invalid_adjustment", "Choose a fixed amount or percentage");
  return roundPositive(basis * BigInt(assertInteger(adjustment.basisPoints, 0, 10000, "basisPoints")), BPS);
}
export function resolveItemizedBill(input: ItemizedIntent): ItemizedResult {
  validateIds(input.participantOrder);
  if (input.items.length < 1 || input.items.length > MAX_ITEMS) refuse("invalid_items", "Enter between 1 and 40 item lines");
  const bases = input.participantOrder.map(() => ZERO);
  const seen = new Set<string>();
  const items = input.items.map(item => {
    if (typeof item.label !== "string" || !item.label.trim() || [...item.label].length > 160) refuse("invalid_label", "Enter a line label up to 160 characters");
    const quantity = parseQuantity(item.quantity);
    if (quantity === null) refuse("invalid_quantity", "Quantity must be positive, at most 1,000,000 with up to three decimal places");
    const total = roundPositive(BigInt(assertInteger(item.unitPriceMinor, 0, MAX_ENTRY_MINOR)) * BigInt(quantity), BigInt(1000));
    if (total > BigInt(MAX_ENTRY_MINOR)) refuse("invalid_amount", "An item total exceeds the entry limit");
    const shares = allocate(Number(total), item.split, true);
    for (const share of shares) {
      const index = input.participantOrder.indexOf(share.memberId);
      if (index < 0) refuse("invalid_participants", "Every item assignee must be in the bill participant order");
      seen.add(share.memberId); bases[index] = bases[index]! + BigInt(share.amountMinor);
    }
    return { label: item.label, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, totalMinor: Number(total), shares };
  });
  if (seen.size !== input.participantOrder.length) refuse("invalid_participants", "Every bill participant must be assigned an item");
  const subtotal = bases.reduce((sum, n) => sum + n, ZERO);
  const discount = adjustmentTotal(input.discount, subtotal);
  if (discount > subtotal) refuse("excessive_discount", "Discount cannot exceed the subtotal");
  const discounts = apportion(discount, bases);
  const discounted = bases.map((base, i) => base - discounts[i]!);
  const discountedSubtotal = subtotal - discount;
  const tax = adjustmentTotal(input.tax, discountedSubtotal), tip = adjustmentTotal(input.tip, discountedSubtotal);
  const taxes = apportion(tax, discounted), tips = apportion(tip, discounted);
  const total = discountedSubtotal + tax + tip;
  if (total <= ZERO || total > BigInt(MAX_ENTRY_MINOR)) refuse("invalid_total", "The final bill must be positive and within the entry limit");
  const breakdown = input.participantOrder.map((memberId, i) => ({ memberId, baseMinor: Number(bases[i]!), discountMinor: Number(discounts[i]!), taxMinor: Number(taxes[i]!), tipMinor: Number(tips[i]!), amountMinor: Number(discounted[i]! + taxes[i]! + tips[i]!) }));
  return { subtotalMinor: Number(subtotal), discountMinor: Number(discount), discountedSubtotalMinor: Number(discountedSubtotal), taxMinor: Number(tax), tipMinor: Number(tip), totalMinor: Number(total), items, breakdown, shares: breakdown.map(({ memberId, amountMinor }) => ({ memberId, amountMinor })) };
}

/** Plain numeric CSV/input text preserves the last minor unit at signed aggregate bounds. */
export function decimalMoney(amountMinor: number, currency: Currency): string {
  assertInteger(amountMinor, -MAX_AGGREGATE_MINOR, MAX_AGGREGATE_MINOR);
  const precision = assertCurrency(currency);
  const sign = amountMinor < 0 ? "-" : "";
  const digits = BigInt(Math.abs(amountMinor)).toString().padStart(precision + 1, "0");
  return sign + (precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits);
}
export function formatMoney(amountMinor: number, currency: Currency, locale = "en-IN"): string {
  const decimal = decimalMoney(amountMinor, currency);
  const precision = assertCurrency(currency);
  const [whole, fraction] = decimal.split(".");
  // Intl receives only an exact integer. Fraction text never passes through Number.
  const integer = whole === "-0" ? -0 : BigInt(whole!);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: precision, maximumFractionDigits: precision }).formatToParts(integer).map(part => part.type === "fraction" ? fraction! : part.value).join("");
}

export interface Rational { numerator: bigint; denominator: bigint }
const MAX_RATIONAL_BITS = 512;
const abs = (n: bigint): bigint => n < ZERO ? -n : n;
export function rational(numerator: bigint, denominator: bigint = ONE): Rational {
  if (denominator === ZERO) refuse("division_by_zero", "Cannot divide by zero");
  if (abs(numerator).toString(2).length > MAX_RATIONAL_BITS || abs(denominator).toString(2).length > MAX_RATIONAL_BITS) refuse("calculation_too_large", "Calculation exceeds the intermediate size limit");
  if (denominator < ZERO) { numerator = -numerator; denominator = -denominator; }
  let a = abs(numerator), b = denominator;
  while (b !== ZERO) { const r = a % b; a = b; b = r; }
  return { numerator: numerator / a, denominator: denominator / a };
}
export function addRational(a: Rational, b: Rational): Rational { return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator); }
export function multiplyRational(a: Rational, b: Rational): Rational { return rational(a.numerator * b.numerator, a.denominator * b.denominator); }
export function divideRational(a: Rational, b: Rational): Rational { return rational(a.numerator * b.denominator, a.denominator * b.numerator); }
export function roundRationalMinor(value: Rational, currency: Currency): number {
  const scale = BigInt(10) ** BigInt(assertCurrency(currency));
  const scaled = multiplyRational(value, rational(scale));
  const rounded = roundPositive(abs(scaled.numerator), scaled.denominator) * (scaled.numerator < ZERO ? -ONE : ONE);
  if (abs(rounded) > BigInt(MAX_ENTRY_MINOR)) refuse("amount_out_of_range", "The applied amount exceeds the entry limit");
  return Number(rounded);
}
