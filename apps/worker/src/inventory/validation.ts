import { ValidationError } from "../platform/errors";
import type { StockLevel } from "./model";

export function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function withDefault(value: string | undefined, fallback: string): string {
  return trimmed(value) || fallback;
}

export function assertLength(field: string, value: string, maximum: number): void {
  if ([...value].length > maximum) {
    throw new ValidationError(field, `must be ${maximum} characters or fewer`);
  }
}

export function normalizeValues(
  field: string,
  values: string[],
  options: { excluded?: string; maximumCount: number; maximumLength: number },
): string[] {
  const excluded = options.excluded?.toLocaleLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalizedValue = value.trim();
    const comparison = normalizedValue.toLocaleLowerCase();
    if (!normalizedValue || comparison === excluded || seen.has(comparison)) continue;
    assertLength(field, normalizedValue, options.maximumLength);
    seen.add(comparison);
    result.push(normalizedValue);
  }

  if (result.length > options.maximumCount) {
    throw new ValidationError(field, `use no more than ${options.maximumCount} values`);
  }
  return result;
}

export function assertNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(field, "must be zero or greater");
  }
}

export function assertPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(field, "must be greater than zero");
  }
}

export function assertPercentage(value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ValidationError("levelPercent", "must be between zero and 100");
  }
}

export function isStockLevel(value: string | undefined): value is StockLevel {
  return value === "full" || value === "okay" || value === "low" || value === "out";
}

export function simpleStockLevel(percentage: number): StockLevel {
  if (percentage <= 0) return "out";
  if (percentage <= 25) return "low";
  if (percentage <= 75) return "okay";
  return "full";
}

export function exactStockLevel(quantity: number, minimum: number): StockLevel {
  if (quantity <= 0) return "out";
  if (quantity <= minimum) return "low";
  return "okay";
}

export function percentageForLevel(level: StockLevel): number {
  if (level === "full") return 100;
  if (level === "low") return 25;
  if (level === "out") return 0;
  return 50;
}
