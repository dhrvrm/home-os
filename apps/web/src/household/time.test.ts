import { describe, expect, it } from "vitest";
import { localDate, addDays, localDateTime, zonedInstant } from "./time";
describe("household time", () => {
  it("uses household calendar dates across UTC midnight", () => {
    expect(localDate("2026-11-12T20:00:00Z", "Asia/Kolkata")).toBe(
      "2026-11-13",
    );
    expect(zonedInstant("2026-11-13T01:30", "Asia/Kolkata")).toBe(
      "2026-11-12T20:00:00.000Z",
    );
    expect(localDateTime("2026-11-12T20:00:00Z", "Asia/Kolkata")).toBe(
      "2026-11-13T01:30",
    );
  });
  it("rejects nonexistent and ambiguous daylight-saving times", () => {
    expect(() => zonedInstant("2026-03-08T02:30", "America/New_York")).toThrow(
      /does not exist/,
    );
    expect(() => zonedInstant("2026-11-01T01:30", "America/New_York")).toThrow(
      /ambiguous/,
    );
    expect(zonedInstant("2026-11-01T03:30", "America/New_York")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });
  it("moves dates across calendar boundaries without device timezone", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => zonedInstant("2026-02-30T12:00", "Asia/Kolkata")).toThrow();
  });
});
