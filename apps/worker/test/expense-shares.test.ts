import { describe, expect, it } from "vitest";
import { resolveShares, type SplitParticipant, type SplitRequest } from "../src/expenses/shares/resolver";

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

describe("expense share resolver", () => {
  it("splits equally when there is no remainder", () => {
    const result = resolveShares(request(3000, equalParticipants("a", "b", "c")));
    expect(result).toEqual({
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
    const first = resolveShares(request(1000, participants));
    const second = resolveShares(request(1000, participants));
    expect(first).toEqual(second);
    expect(amounts(first).reduce((sum, amount) => sum + amount, 0)).toBe(1000);
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

  it("takes percentages from the total next", () => {
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
    const result = resolveShares(
      request(5000, [
        { memberId: "a", override: { kind: "fixed", amountMinor: 6000 } },
        { memberId: "b" },
      ]),
    );
    expect(result).toEqual({ ok: false, reason: "overrides_exceed_total" });
  });

  it("refuses a split where nobody absorbs the remainder", () => {
    const result = resolveShares(
      request(5000, [
        { memberId: "a", override: { kind: "fixed", amountMinor: 2000 } },
        { memberId: "b", override: { kind: "fixed", amountMinor: 1000 } },
      ]),
    );
    expect(result).toEqual({ ok: false, reason: "unassigned_remainder" });
  });

  it("refuses a split with no participants", () => {
    expect(resolveShares(request(5000, []))).toEqual({ ok: false, reason: "no_participants" });
  });

  it("refuses malformed overrides", () => {
    const negativeFixed = resolveShares(
      request(5000, [{ memberId: "a", override: { kind: "fixed", amountMinor: -1 } }, { memberId: "b" }]),
    );
    expect(negativeFixed).toEqual({ ok: false, reason: "invalid_override" });

    const fractionalFixed = resolveShares(
      request(5000, [{ memberId: "a", override: { kind: "fixed", amountMinor: 10.5 } }, { memberId: "b" }]),
    );
    expect(fractionalFixed).toEqual({ ok: false, reason: "invalid_override" });

    for (const basisPoints of [0, 10001, 250.5]) {
      const result = resolveShares(
        request(5000, [{ memberId: "a", override: { kind: "percent", basisPoints } }, { memberId: "b" }]),
      );
      expect(result).toEqual({ ok: false, reason: "invalid_override" });
    }
  });

  it("distributes the remainder deterministically for zero-minor-unit currencies", () => {
    const result = resolveShares(request(1000, equalParticipants("a", "b", "c"), 0));
    expect(amounts(result)).toEqual([334, 333, 333]);
    expect(amounts(result).reduce((sum, amount) => sum + amount, 0)).toBe(1000);
  });
});
