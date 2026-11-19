import type { LedgerPage } from "./types";
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function validDate(date: string): boolean {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith("0000") && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date; }
  catch { return false; }
}

export const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
export function validPage<T>(valid: (row: unknown) => row is T) { return (value: unknown): value is LedgerPage<T> => object(value) && integer(value.revision) && value.revision >= 0 && (value.nextCursor === null || typeof value.nextCursor === "string") && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(valid); }
