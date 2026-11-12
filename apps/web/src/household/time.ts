/** Household calendar arithmetic is deliberately independent of the device timezone. */
export function localDateTime(
  instant: string | Date,
  timezone: string,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (name: string) =>
    parts.find((part) => part.type === name)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}
export function localDate(instant: string | Date, timezone: string): string {
  return localDateTime(instant, timezone).slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function zonedInstant(input: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input))
    throw new Error("Enter a valid date and cooking time.");
  const wall = Date.parse(`${input}:00Z`);
  if (
    !Number.isFinite(wall) ||
    new Date(wall).toISOString().slice(0, 16) !== input
  )
    throw new Error("Enter a valid date and cooking time.");
  // Collect zone offsets either side of a possible transition, then require exactly one round trip.
  const offsets = new Set<number>();
  for (const delta of [-48, -24, 0, 24, 48]) {
    const sample = wall + delta * 3_600_000;
    offsets.add(
      Date.parse(`${localDateTime(new Date(sample), timezone)}:00Z`) - sample,
    );
  }
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => localDateTime(new Date(instant), timezone) === input);
  if (matches.length === 0)
    throw new Error(
      `This time does not exist in ${timezone}. Choose another time.`,
    );
  if (matches.length > 1)
    throw new Error(
      `This time is ambiguous in ${timezone}. Choose a time outside the repeated hour.`,
    );
  return new Date(matches[0]).toISOString();
}
export function displayTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
}
export function displayDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}
