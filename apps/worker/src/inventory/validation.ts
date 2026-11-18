import { z } from "zod";
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

export const MAX_RESTOCK_INTERVAL_DAYS = 3650;

export function assertRestockInterval(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_RESTOCK_INTERVAL_DAYS) {
    throw new ValidationError(
      "restockIntervalDays",
      `must be a whole number of days between 1 and ${MAX_RESTOCK_INTERVAL_DAYS}`,
    );
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

const trackingMode = z.enum(["simple", "exact"]);
const stockLevel = z.enum(["full", "okay", "low", "out"]);
export const createItemInput = z.object({
  id: z.string().min(1).optional(),
  name: z.string(),
  alternativeNames: z.array(z.string()).optional(),
  category: z.string().optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  trackingMode: trackingMode.optional(),
  quantity: z.number().optional(),
  stockLevel: stockLevel.optional(),
  levelPercent: z.number().optional(),
  minQuantity: z.number().optional(),
  restockIntervalDays: z.number().nullable().optional(),
});
export const updateItemInput = z.object({
  name: z.string().optional(),
  alternativeNames: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
  minQuantity: z.number().optional(),
  restockIntervalDays: z.number().nullable().optional(),
});
export const stockEventInput = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(["consume", "restock", "mark_level"]),
  quantity: z.number().optional(),
  stockLevel: stockLevel.optional(),
  levelPercent: z.number().optional(),
  note: z.string().optional(),
});


export const pageInput = z.object({
  limit: z.number().int().min(1).max(50).default(25),
  cursor: z.string().max(1024).optional(),
});
export interface PageInput { limit?: number; cursor?: string; }
export interface Page<T> { items: T[]; nextCursor: string | null; }
export function pageLimit(input: PageInput): number {
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError('limit', 'must be between 1 and 50');
  return limit;
}
export function readCursor(cursor?: string): string[] {
  if (!cursor) return [];
  try {
    const value: unknown = JSON.parse(decodeURIComponent(atob(cursor)));
    if (!Array.isArray(value) || value.length > 3 || !value.every(part => typeof part === 'string' && part.length <= 256)) throw new Error('cursor');
    return value;
  } catch { throw new ValidationError('cursor', 'must be a valid page cursor'); }
}
export function writeCursor(...values: string[]): string { return btoa(encodeURIComponent(JSON.stringify(values))); }
