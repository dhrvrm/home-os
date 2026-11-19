import type { SplitIntent } from "./ledger-money";

/** Hand-calculated expectations shared by both transport boundary test suites. */
export const allocationFixtures: Array<{ name: string; totalMinor: number; split: SplitIntent; expected: number[] }> = [
  { name: "AE3 INR equal thirds", totalMinor: 10000, split: { mode: "equal", participants: ["a", "b", "c"].map(memberId => ({ memberId, kind: "equal" })) }, expected: [3334, 3333, 3333] },
  { name: "AE3 JPY one yen", totalMinor: 1, split: { mode: "equal", participants: ["z", "a", "b"].map(memberId => ({ memberId, kind: "equal" })) }, expected: [1, 0, 0] },
  { name: "AE4 fixed then original percent then weighted", totalMinor: 100000, split: { mode: "mixed", participants: [
    { memberId: "a", kind: "fixed", amountMinor: 20000 }, { memberId: "b", kind: "percent", basisPoints: 3000 },
    { memberId: "c", kind: "weight", weight: 1 }, { memberId: "d", kind: "weight", weight: 3 },
  ] }, expected: [20000, 30000, 12500, 37500] },
  { name: "collective percentage floor before remainder", totalMinor: 3, split: { mode: "mixed", participants: [
    { memberId: "z", kind: "percent", basisPoints: 2500 }, { memberId: "a", kind: "percent", basisPoints: 2500 },
    { memberId: "c", kind: "equal" },
  ] }, expected: [1, 0, 2] },
  { name: "mixed equal and human one-share weight", totalMinor: 10, split: { mode: "mixed", participants: [
    { memberId: "equal", kind: "equal" }, { memberId: "weighted", kind: "weight", weight: 10000 },
  ] }, expected: [5, 5] },
  { name: "mixed equal and human three-share weight", totalMinor: 8, split: { mode: "mixed", participants: [
    { memberId: "equal", kind: "equal" }, { memberId: "weighted", kind: "weight", weight: 30000 },
  ] }, expected: [2, 6] },
  { name: "weighted largest fractions then order", totalMinor: 5, split: { mode: "weighted", participants: [
    { memberId: "z", kind: "weight", weight: 1 }, { memberId: "a", kind: "weight", weight: 3 },
  ] }, expected: [1, 4] },
  { name: "percentage-only collectively covers total", totalMinor: 1001, split: { mode: "percentage", participants: [
    { memberId: "z", kind: "percent", basisPoints: 5000 }, { memberId: "a", kind: "percent", basisPoints: 5000 },
  ] }, expected: [501, 500] },
];

export const itemizedFixture = {
  participantOrder: ["a", "b"],
  items: [
    { label: "A item", unitPriceMinor: 30000, quantity: "1", split: { mode: "equal" as const, participants: [{ memberId: "a", kind: "equal" as const }] } },
    { label: "B item", unitPriceMinor: 70000, quantity: "1", split: { mode: "equal" as const, participants: [{ memberId: "b", kind: "equal" as const }] } },
  ],
  discount: { kind: "fixed" as const, amountMinor: 10000 },
  tax: { kind: "percent" as const, basisPoints: 1000 },
  tip: { kind: "fixed" as const, amountMinor: 9000 },
};
