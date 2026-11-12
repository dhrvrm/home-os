import { ValidationError } from "../platform/errors";

export function assertTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
  } catch {
    throw new ValidationError("timezone", "enter a valid IANA timezone");
  }
  return zone;
}

function localParts(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (key: string) => parts.find((part) => part.type === key)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}`;
}

/** Local form values must identify exactly one real instant in the household zone. */
export function cookingInstant(value: string, zone: string): string {
  assertTimezone(zone);
  const explicit =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (explicit.test(value)) {
    assertDate(value.slice(0, 10), "cookingAt");
    const time = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)!;
    if (
      Number(time[1]) > 23 ||
      Number(time[2]) > 59 ||
      Number(time[3] ?? 0) > 59
    ) {
      throw new ValidationError("cookingAt", "enter a real cooking time");
    }
    const instant = new Date(value);
    if (Number.isFinite(instant.getTime())) return instant.toISOString();
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value,
  );
  if (!match)
    throw new ValidationError("cookingAt", "enter an unambiguous cooking time");
  assertDate(match[1], "cookingAt");
  if (
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4] ?? 0) > 59
  ) {
    throw new ValidationError("cookingAt", "enter a real cooking time");
  }
  const normalized = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  const baseline = Date.parse(`${normalized}Z`);
  const offsets = new Set<number>();
  // Sample either side of any adjacent offset transition, then round-trip each possible instant.
  for (const delta of [-36, -12, 0, 12, 36]) {
    const at = baseline + delta * 3600000;
    offsets.add(Date.parse(`${localParts(at, zone)}Z`) - at);
  }
  const candidates = [...offsets]
    .map((offset) => baseline - offset)
    .filter((at) => localParts(at, zone) === normalized);
  if (candidates.length !== 1) {
    throw new ValidationError(
      "cookingAt",
      "this local time is missing or ambiguous; choose another time or an explicit UTC instant",
    );
  }
  return new Date(candidates[0]).toISOString();
}

export function assertDate(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(field, "enter a date in YYYY-MM-DD form");
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new ValidationError(field, "enter a real calendar date");
  }
  return timestamp;
}

function dayBoundary(date: string, zone: string): string {
  // Find the first instant with this local date, including zones whose midnight is skipped.
  const baseline = assertDate(date, "from");
  let low = baseline - 36 * 3600000,
    high = baseline + 36 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localParts(mid, zone).slice(0, 10) < date) low = mid;
    else high = mid;
  }
  return new Date(high).toISOString();
}

export function menuBounds(
  from: string,
  to: string,
  zone: string,
): { from: string; to: string } {
  assertTimezone(zone);
  const start = assertDate(from, "from"),
    end = assertDate(to, "to");
  if (end <= start || end - start > 31 * 86400000) {
    throw new ValidationError(
      "to",
      "choose an exclusive end date within 31 days of the start",
    );
  }
  return { from: dayBoundary(from, zone), to: dayBoundary(to, zone) };
}
