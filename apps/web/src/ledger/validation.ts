export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function validDate(date: string): boolean {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith("0000") && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date; }
  catch { return false; }
}
