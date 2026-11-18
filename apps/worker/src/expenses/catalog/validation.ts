import { z } from "zod";
import { ValidationError } from "../../platform/errors";
import type { Cadence, CadenceUnit } from "./model";

export const MAX_NAME_LENGTH = 120;
export const MAX_PARTICIPANTS = 12;
export const MAX_CADENCE_INTERVAL = 365;
export const MAX_AMOUNT_MINOR = 100_000_000_00;

const ANCHOR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function assertName(value: string): string {
  const name = value.trim();
  if (!name) throw new ValidationError("name", "enter an expense name");
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new ValidationError("name", `must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return name;
}

export function assertAmountMinor(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError("amountMinor", "must be a whole amount greater than zero");
  }
  if (value > MAX_AMOUNT_MINOR) {
    throw new ValidationError("amountMinor", "is larger than this household can record");
  }
  return value;
}

export function assertCadence(cadence: Cadence): Cadence {
  if (!isCadenceUnit(cadence.unit)) {
    throw new ValidationError("cadence", "must repeat by day, week, month, or year");
  }
  if (!Number.isSafeInteger(cadence.interval) || cadence.interval < 1 || cadence.interval > MAX_CADENCE_INTERVAL) {
    throw new ValidationError("cadence", `must repeat every 1 to ${MAX_CADENCE_INTERVAL} periods`);
  }
  if (!isCalendarDate(cadence.anchorDate)) {
    throw new ValidationError("cadence", "must start from a real date in YYYY-MM-DD form");
  }
  return { unit: cadence.unit, interval: cadence.interval, anchorDate: cadence.anchorDate };
}

function isCadenceUnit(value: string): value is CadenceUnit {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function isCalendarDate(value: string): boolean {
  const match = ANCHOR_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const override = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amountMinor: z.number() }),
  z.object({ kind: z.literal("percent"), basisPoints: z.number() }),
]);
const participant = z.object({
  memberId: z.string().min(1),
  override: override.nullish(),
});
const cadence = z.object({
  unit: z.enum(["day", "week", "month", "year"]),
  interval: z.number(),
  anchorDate: z.string(),
});

export const createExpenseInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string(),
  amountMinor: z.number(),
  currency: z.string().optional(),
  cadence,
  participants: z.array(participant),
});

export const updateExpenseInput = z.object({
  name: z.string().optional(),
  amountMinor: z.number().optional(),
  currency: z.string().optional(),
  cadence: cadence.optional(),
  participants: z.array(participant).optional(),
});

// Direct HTTP keeps its established unknown-field stripping. Connected commands
// reject unknown fields at every object boundary while sharing the same field schemas.
const strictParticipant = participant.extend({
  override: z.discriminatedUnion("kind", [override.options[0].strict(), override.options[1].strict()]).nullish(),
}).strict();
export const strictCreateExpenseInput = createExpenseInput.extend({
  cadence: cadence.strict(),
  participants: z.array(strictParticipant),
}).strict();
export const strictUpdateExpenseInput = updateExpenseInput.extend({
  cadence: cadence.strict().optional(),
  participants: z.array(strictParticipant).optional(),
}).strict();
