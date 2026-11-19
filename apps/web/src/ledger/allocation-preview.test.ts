import { describe, expect, it } from "vitest";
import { allocationFixtures, itemizedFixture } from "../../../../shared/ledger-money.fixtures";
import { previewAllocation, previewItemizedBill } from "./allocation-preview";

describe("browser allocation boundary", () => {
  for (const f of allocationFixtures) it(f.name, () => expect(previewAllocation(f.totalMinor, f.split).map(s => s.amountMinor)).toEqual(f.expected));
  it("explains adjusted item allocations using independent expected totals", () => {
    expect(previewItemizedBill(itemizedFixture)).toMatchObject({ totalMinor: 108000, shares: [{ memberId: "a", amountMinor: 32400 }, { memberId: "b", amountMinor: 75600 }] });
  });
  it("refuses incomplete shares rather than displaying an invented remainder", () => {
    expect(() => previewAllocation(10, { mode: "exact", participants: [{ memberId: "a", kind: "fixed", amountMinor: 9 }] })).toThrow();
  });
});

describe("browser preview invariants", () => {
  it("conserves many tiny totals and keeps equal ties in recorded order", () => {
    for (let total = 1; total <= 97; total += 2) for (let count = 1; count <= 12; count++) {
      const ids = Array.from({ length: count }, (_, index) => `p${count - index}`);
      const result = previewAllocation(total, { mode: "equal", participants: ids.map(memberId => ({ memberId, kind: "equal" })) });
      expect(result.map(s => s.memberId)).toEqual(ids);
      expect(result.reduce((sum, s) => sum + s.amountMinor, 0)).toBe(total);
      expect(result.map(s => s.amountMinor)).toEqual(ids.map((_, i) => Math.floor(total / count) + (i < total % count ? 1 : 0)));
    }
  });
  it("rejects duplicate preview people and missing item assignees", () => {
    expect(() => previewAllocation(1, { mode: "equal", participants: [{ memberId: "a", kind: "equal" }, { memberId: "a", kind: "equal" }] })).toThrow();
    expect(() => previewItemizedBill({ ...itemizedFixture, participantOrder: ["a"] })).toThrow();
  });
});
