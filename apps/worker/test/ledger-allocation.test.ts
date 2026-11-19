import { describe, expect, it } from "vitest";
import { allocationFixtures, itemizedFixture } from "../../../shared/ledger-money.fixtures";
import { MAX_ENTRY_MINOR, WEIGHT_SCALE, decimalMoney, formatMoney, parseMoney, parsePercentage, parseWeight, resolveAllocation, resolveItemizedBill, type SplitIntent } from "../../../shared/ledger-money";
import { resolveExpense } from "../src/ledger/allocation";

const equal = (...ids: string[]): SplitIntent => ({ mode: "equal", participants: ids.map(memberId => ({ memberId, kind: "equal" })) });
const values = (shares: Array<{ amountMinor: number }>) => shares.map(s => s.amountMinor);

describe("exact actual-expense allocations", () => {
  for (const f of allocationFixtures) it(f.name, () => {
    expect(values(resolveAllocation(f.totalMinor, f.split))).toEqual(f.expected);
    expect(values(resolveExpense({ kind: "expense", date: "2026-11-19", description: f.name, currency: "INR", totalMinor: f.totalMinor, payers: [{ memberId: f.split.participants[0]!.memberId, amountMinor: f.totalMinor }], allocation: { kind: "split", split: f.split } }).shares)).toEqual(f.expected);
  });
  it("conserves generated weighted and mixed allocations with deterministic order", () => {
    for (let total = 1; total <= 151; total += 3) for (let n = 1; n <= 12; n++) {
      const participants = Array.from({ length: n }, (_, i) => ({ memberId: `p${i}`, kind: "weight" as const, weight: (i + 1) * 7919 }));
      const split: SplitIntent = { mode: "weighted", participants };
      const result = resolveAllocation(total, split);
      expect(result.reduce((s, p) => s + p.amountMinor, 0)).toBe(total);
      expect(result).toEqual(resolveAllocation(total, split));
      expect(result.every(p => Number.isSafeInteger(p.amountMinor) && p.amountMinor >= 0)).toBe(true);
      const mixed: SplitIntent = { mode: "mixed", participants: [{ memberId: "fixed", kind: "fixed", amountMinor: 0 }, { memberId: "pct", kind: "percent", basisPoints: 3333 }, ...participants.slice(0, 10)] };
      expect(resolveAllocation(total, mixed).reduce((s, p) => s + p.amountMinor, 0)).toBe(total);
    }
  });
  it("rejects under-allocation, excess, duplicate IDs and invalid mode intent", () => {
    for (const split of [
      { mode: "exact", participants: [{ memberId: "a", kind: "fixed", amountMinor: 9 }] },
      { mode: "percentage", participants: [{ memberId: "a", kind: "percent", basisPoints: 9999 }] },
      { mode: "mixed", participants: [{ memberId: "a", kind: "fixed", amountMinor: 11 }, { memberId: "b", kind: "equal" }] },
      equal("a", "a"), { mode: "equal", participants: [{ memberId: "a", kind: "fixed", amountMinor: 10 }] },
      { mode: "weighted", participants: [{ memberId: "a", kind: "weight", weight: 0 }] },
    ] as SplitIntent[]) expect(() => resolveAllocation(10, split)).toThrow();
    for (const total of [-1, 0, 1.1, MAX_ENTRY_MINOR + 1, Number.MAX_SAFE_INTEGER + 1]) expect(() => resolveAllocation(total, equal("a"))).toThrow();
    expect(() => resolveAllocation(10, equal(...Array.from({ length: 13 }, (_, i) => `${i}`)))).toThrow();
  });
  it("uses exact integer products at the largest entry boundary", () => {
    expect(values(resolveAllocation(MAX_ENTRY_MINOR, { mode: "percentage", participants: [{ memberId: "a", kind: "percent", basisPoints: 9999 }, { memberId: "b", kind: "percent", basisPoints: 1 }] }))).toEqual([9999000000, 1000000]);
  });
});

describe("item adjustments and contribution conservation", () => {
  it("AE5 applies discount then independent tax and tip", () => {
    const result = resolveItemizedBill(itemizedFixture);
    expect(result).toMatchObject({ subtotalMinor: 100000, discountMinor: 10000, discountedSubtotalMinor: 90000, taxMinor: 9000, tipMinor: 9000, totalMinor: 108000 });
    expect(values(result.shares)).toEqual([32400, 75600]);
    expect(result.breakdown).toEqual([
      { memberId: "a", baseMinor: 30000, discountMinor: 3000, taxMinor: 2700, tipMinor: 2700, amountMinor: 32400 },
      { memberId: "b", baseMinor: 70000, discountMinor: 7000, taxMinor: 6300, tipMinor: 6300, amountMinor: 75600 },
    ]);
  });
  it("rounds quantities and adjustment totals half-up and permits zero lines", () => {
    const result = resolveItemizedBill({ participantOrder: ["b", "a"], items: [
      { label: "half", unitPriceMinor: 1, quantity: "1.500", split: equal("a", "b") },
      { label: "free", unitPriceMinor: 0, quantity: "2", split: equal("a") },
    ], tax: { kind: "percent", basisPoints: 2500 }, tip: { kind: "percent", basisPoints: 2500 } });
    expect(result.totalMinor).toBe(4);
    expect(result.items.map(i => i.totalMinor)).toEqual([2, 0]);
    expect(values(result.shares)).toEqual([3, 1]);
  });
  it("allows full discount only when another positive-basis outcome is possible", () => {
    const input = { participantOrder: ["a"], items: [{ label: "item", unitPriceMinor: 10, quantity: "1", split: equal("a") }] };
    expect(() => resolveItemizedBill({ ...input, discount: { kind: "percent", basisPoints: 10000 } })).toThrow();
    expect(() => resolveItemizedBill({ ...input, discount: { kind: "fixed", amountMinor: 10 }, tip: { kind: "fixed", amountMinor: 1 } })).toThrow();
    expect(() => resolveItemizedBill({ ...input, discount: { kind: "fixed", amountMinor: 11 } })).toThrow();
    expect(() => resolveItemizedBill({ ...input, tax: { kind: "percent", basisPoints: 10001 } })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: [{ ...input.items[0]!, quantity: "0" }] })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: [{ ...input.items[0]!, quantity: "1.0001" }] })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: [{ ...input.items[0]!, quantity: "1000000.001" }] })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: [{ ...input.items[0]!, split: equal() }] })).toThrow();
    expect(() => resolveItemizedBill({ ...input, participantOrder: ["b"] })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: Array.from({ length: 41 }, () => input.items[0]!) })).toThrow();
    expect(() => resolveItemizedBill({ ...input, items: [{ ...input.items[0]!, unitPriceMinor: MAX_ENTRY_MINOR, quantity: "2" }] })).toThrow();
  });
  it("requires independent payer/share totals and union of at most 12 people", () => {
    const input = { kind: "expense" as const, date: "2026-11-19", description: "bill", currency: "INR" as const, totalMinor: 108000, payers: [{ memberId: "a", amountMinor: 108000 }], allocation: { kind: "itemized" as const, ...itemizedFixture } };
    expect(resolveExpense(input).shares.map(s => s.amountMinor)).toEqual([32400, 75600]);
    expect(() => resolveExpense({ ...input, totalMinor: 108001 })).toThrow();
    expect(() => resolveExpense({ ...input, payers: [{ memberId: "a", amountMinor: 1 }] })).toThrow();
    expect(() => resolveExpense({ ...input, payers: [{ memberId: "a", amountMinor: 54000 }, { memberId: "a", amountMinor: 54000 }] })).toThrow();
    expect(() => resolveExpense({ ...input, payers: Array.from({ length: 12 }, (_, i) => ({ memberId: `p${i}`, amountMinor: 9000 })) })).toThrow();
  });
});

describe("exact text money boundary", () => {
  it("preserves the last signed minor unit in every currency and CSV decimal", () => {
    for (const currency of ["INR", "USD", "EUR", "GBP", "JPY"] as const) for (const sign of [1, -1]) {
      const amount = sign * Number.MAX_SAFE_INTEGER;
      const decimal = decimalMoney(amount, currency);
      expect(decimal).toBe(`${sign < 0 ? "-" : ""}${currency === "JPY" ? "9007199254740991" : "90071992547409.91"}`);
      expect(formatMoney(amount, currency).replace(/[^\d.-]/g, "")).toBe(decimal);
    }
    expect(formatMoney(123456, "INR")).toBe("₹1,234.56");
    expect(formatMoney(1235, "JPY")).toBe("JP¥1,235");
  });
  it("parses bounded decimal inputs without floating scaling", () => {
    expect(parseMoney("0.01", "USD")).toBe(1);
    expect(parseMoney("100000000.00", "INR")).toBe(MAX_ENTRY_MINOR);
    for (const text of ["1.001", "-1", "1e3", "Infinity", "100000000.01", "9007199254740992", "", "1."]) expect(parseMoney(text, "INR")).toBeNull();
    expect(parseMoney("1.1", "JPY")).toBeNull();
    expect(parsePercentage("33.33")).toBe(3333);
    expect(parsePercentage("33.333")).toBeNull();
    expect(parsePercentage("100.01")).toBeNull();
    expect(WEIGHT_SCALE).toBe(10000);
    expect(parseWeight("1")).toBe(WEIGHT_SCALE);
    expect(parseWeight("1.0001")).toBe(10001);
    for (const value of ["0", "10000.0001", "1.00001"]) expect(parseWeight(value)).toBeNull();
  });
});

describe("independent exact-mode and adjustment boundaries", () => {
  it("preserves zero exact shares and all the stated fixed amounts", () => {
    expect(values(resolveAllocation(10, { mode: "exact", participants: [{ memberId: "a", kind: "fixed", amountMinor: 0 }, { memberId: "b", kind: "fixed", amountMinor: 10 }] }))).toEqual([0, 10]);
    expect(values(resolveAllocation(2, { mode: "mixed", participants: [{ memberId: "z", kind: "percent", basisPoints: 5000 }, { memberId: "a", kind: "percent", basisPoints: 5000 }] }))).toEqual([1, 1]);
  });
  it("rounds a percentage discount once and apportions residuals in bill order", () => {
    const result = resolveItemizedBill({ participantOrder: ["z", "a"], items: [
      { label: "same price", unitPriceMinor: 3, quantity: "1", split: equal("a", "z") },
    ], discount: { kind: "percent", basisPoints: 5000 }, tax: { kind: "fixed", amountMinor: 1 }, tip: { kind: "fixed", amountMinor: 2 } });
    // Base z/a = 1/2; rounded discount 2 gives 1/1, leaving 0/1.
    expect(result).toMatchObject({ subtotalMinor: 3, discountMinor: 2, taxMinor: 1, tipMinor: 2, totalMinor: 4 });
    expect(result.breakdown).toEqual([
      { memberId: "z", baseMinor: 1, discountMinor: 1, taxMinor: 0, tipMinor: 0, amountMinor: 0 },
      { memberId: "a", baseMinor: 2, discountMinor: 1, taxMinor: 1, tipMinor: 2, amountMinor: 4 },
    ]);
  });
  it("accepts maximal quantity and forty lines within the final entry bound", () => {
    const result = resolveItemizedBill({ participantOrder: ["a"], items: Array.from({ length: 40 }, () => ({ label: "bulk", unitPriceMinor: 1, quantity: "1000000", split: equal("a") })) });
    expect(result.totalMinor).toBe(40000000);
    expect(values(result.shares)).toEqual([40000000]);
  });
  it("formats negative sub-unit amounts without losing the minus sign", () => {
    expect(decimalMoney(-1, "USD")).toBe("-0.01");
    expect(formatMoney(-1, "USD")).toBe("-$0.01");
    expect(() => decimalMoney(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow();
    expect(() => decimalMoney(0.5, "USD")).toThrow();
    expect(parseMoney("000001.01", "INR")).toBe(101);
    expect(parseMoney("9".repeat(129), "INR")).toBeNull();
  });
});
