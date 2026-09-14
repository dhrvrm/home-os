import { describe, expect, it } from "vitest";
import {
  describeCadence,
  formatBasisPoints,
  formatMinorAmount,
  minorAmountInputValue,
  parseBasisPoints,
  parseMinorAmount,
  resolveShares,
  type SplitParticipant,
  type SplitRequest,
} from "./expenses";

function request(totalMinor: number, participants: SplitParticipant[], minorUnit = 2): SplitRequest {
  return { totalMinor, minorUnit, participants };
}

function equalParticipants(...memberIds: string[]): SplitParticipant[] {
  return memberIds.map((memberId) => ({ memberId }));
}

function amounts(result: ReturnType<typeof resolveShares>): number[] {
  if (!result.ok) throw new Error(`expected a resolved split, got ${result.reason}`);
  return result.shares.map((share) => share.amountMinor);
}

describe("expense split preview resolver", () => {
  it("splits equally when there is no remainder", () => {
    expect(resolveShares(request(3000, equalParticipants("a", "b", "c")))).toEqual({
      ok: true,
      shares: [
        { memberId: "a", amountMinor: 1000 },
        { memberId: "b", amountMinor: 1000 },
        { memberId: "c", amountMinor: 1000 },
      ],
    });
  });

  it("assigns an equal-split remainder to the earliest participants in input order", () => {
    const result = resolveShares(request(1000, equalParticipants("a", "b", "c")));
    expect(amounts(result)).toEqual([334, 333, 333]);
    expect(amounts(result).reduce((sum, amount) => sum + amount, 0)).toBe(1000);
  });

  it("resolves the same request identically every time", () => {
    const participants = equalParticipants("a", "b", "c", "d", "e", "f", "g");
    expect(resolveShares(request(1000, participants))).toEqual(resolveShares(request(1000, participants)));
  });

  it("takes fixed overrides from the total first", () => {
    const result = resolveShares(
      request(5000, [
        { memberId: "a", override: { kind: "fixed", amountMinor: 2000 } },
        { memberId: "b" },
        { memberId: "c" },
      ]),
    );
    expect(amounts(result)).toEqual([2000, 1500, 1500]);
  });

  it("takes percentages from the total, not from the post-fixed remainder", () => {
    const result = resolveShares(
      request(10000, [
        { memberId: "a", override: { kind: "percent", basisPoints: 2550 } },
        { memberId: "b" },
        { memberId: "c" },
      ]),
    );
    expect(amounts(result)).toEqual([2550, 3725, 3725]);
  });

  it("keeps rounded percentages summing to the total", () => {
    const result = resolveShares(
      request(1001, [
        { memberId: "a", override: { kind: "percent", basisPoints: 5000 } },
        { memberId: "b" },
        { memberId: "c" },
      ]),
    );
    expect(amounts(result)).toEqual([500, 251, 250]);
    expect(amounts(result).reduce((sum, amount) => sum + amount, 0)).toBe(1001);
  });

  it("distributes a percentage-only rounding shortfall by largest remainder", () => {
    const result = resolveShares(
      request(1001, [
        { memberId: "a", override: { kind: "percent", basisPoints: 5000 } },
        { memberId: "b", override: { kind: "percent", basisPoints: 5000 } },
      ]),
    );
    expect(amounts(result)).toEqual([501, 500]);
  });

  it("combines fixed, percentage, and equal participants in one rule", () => {
    const result = resolveShares(
      request(10000, [
        { memberId: "a", override: { kind: "fixed", amountMinor: 2000 } },
        { memberId: "b", override: { kind: "percent", basisPoints: 2500 } },
        { memberId: "c" },
        { memberId: "d" },
      ]),
    );
    expect(amounts(result)).toEqual([2000, 2500, 2750, 2750]);
  });

  it("resolves when every participant has an override summing exactly to the total", () => {
    const result = resolveShares(
      request(5000, [
        { memberId: "a", override: { kind: "fixed", amountMinor: 2000 } },
        { memberId: "b", override: { kind: "percent", basisPoints: 6000 } },
      ]),
    );
    expect(amounts(result)).toEqual([2000, 3000]);
  });

  it("refuses overrides that exceed the total", () => {
    expect(
      resolveShares(
        request(5000, [
          { memberId: "a", override: { kind: "fixed", amountMinor: 6000 } },
          { memberId: "b" },
        ]),
      ),
    ).toEqual({ ok: false, reason: "overrides_exceed_total" });
  });

  it("refuses a split where nobody absorbs the remainder", () => {
    expect(
      resolveShares(
        request(5000, [
          { memberId: "a", override: { kind: "fixed", amountMinor: 2000 } },
          { memberId: "b", override: { kind: "fixed", amountMinor: 1000 } },
        ]),
      ),
    ).toEqual({ ok: false, reason: "unassigned_remainder" });
  });

  it("refuses a split with no participants", () => {
    expect(resolveShares(request(5000, []))).toEqual({ ok: false, reason: "no_participants" });
  });

  it("refuses malformed overrides", () => {
    expect(
      resolveShares(request(5000, [{ memberId: "a", override: { kind: "fixed", amountMinor: -1 } }, { memberId: "b" }])),
    ).toEqual({ ok: false, reason: "invalid_override" });
    expect(
      resolveShares(request(5000, [{ memberId: "a", override: { kind: "fixed", amountMinor: 10.5 } }, { memberId: "b" }])),
    ).toEqual({ ok: false, reason: "invalid_override" });

    for (const basisPoints of [0, 10001, 250.5]) {
      expect(
        resolveShares(request(5000, [{ memberId: "a", override: { kind: "percent", basisPoints } }, { memberId: "b" }])),
      ).toEqual({ ok: false, reason: "invalid_override" });
    }
  });

  it("distributes the remainder deterministically for zero-minor-unit currencies", () => {
    const result = resolveShares(request(1000, equalParticipants("a", "b", "c"), 0));
    expect(amounts(result)).toEqual([334, 333, 333]);
  });
});

describe("expense formatting", () => {
  it("renders minor units with the currency's decimal places", () => {
    expect(formatMinorAmount(123456, "INR")).toBe("₹1,234.56");
    expect(formatMinorAmount(5, "INR")).toBe("₹0.05");
    expect(formatMinorAmount(0, "USD")).toBe("$0.00");
  });

  it("renders a zero-minor-unit currency without decimals", () => {
    expect(formatMinorAmount(1235, "JPY")).toBe("JP¥1,235");
  });

  it("parses major-unit entries into integer minor units", () => {
    expect(parseMinorAmount("1234.56", "INR")).toBe(123456);
    expect(parseMinorAmount("1234.5", "INR")).toBe(123450);
    expect(parseMinorAmount("1234", "INR")).toBe(123400);
    expect(parseMinorAmount("1235", "JPY")).toBe(1235);
  });

  it("rejects entries with more decimals than the currency allows", () => {
    expect(parseMinorAmount("1234.567", "INR")).toBeNull();
    expect(parseMinorAmount("1234.5", "JPY")).toBeNull();
    expect(parseMinorAmount("", "INR")).toBeNull();
    expect(parseMinorAmount("-5", "INR")).toBeNull();
    expect(parseMinorAmount("abc", "INR")).toBeNull();
  });

  it("converts percentage entries to integer basis points and back", () => {
    expect(parseBasisPoints("25.5")).toBe(2550);
    expect(parseBasisPoints("100")).toBe(10000);
    expect(parseBasisPoints("25.555")).toBeNull();
    expect(formatBasisPoints(2550)).toBe("25.5");
    expect(formatBasisPoints(10000)).toBe("100");
  });

  it("renders minor units as an editable major-unit entry", () => {
    expect(minorAmountInputValue(500000, "INR")).toBe("5000.00");
    expect(minorAmountInputValue(5, "INR")).toBe("0.05");
    expect(minorAmountInputValue(1235, "JPY")).toBe("1235");
  });

  it("describes a cadence in plain language", () => {
    expect(describeCadence({ unit: "month", interval: 1, anchorDate: "2026-09-01" })).toBe(
      "Every month from 1 Sept 2026",
    );
    expect(describeCadence({ unit: "week", interval: 2, anchorDate: "2026-09-01" })).toBe(
      "Every 2 weeks from 1 Sept 2026",
    );
  });
});
