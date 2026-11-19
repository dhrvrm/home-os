import { describe, expect, it } from "vitest";
import { ledgerCommandInput, expenseInput, MAX_REQUEST_BYTES, parseLedgerRequest } from "../src/ledger/validation";

const expense = { kind: "expense", date: "2026-11-19", description: "Groceries", currency: "INR", totalMinor: 100, payers: [{ memberId: "a", amountMinor: 100 }], allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "b", kind: "equal" }] } } };
const command = { operationId: "operation-1", action: "create", entry: expense };

describe("bounded strict financial inputs", () => {
  it("accepts normalized actual expenses and every later command concept", () => {
    expect(expenseInput.parse(expense)).toEqual(expense);
    for (const input of [command,
      { operationId: "o", action: "create", entry: { kind: "refund", expenseId: "e", date: "2026-11-19", description: "Returned item", currency: "INR", totalMinor: 100, payers: [{ memberId: "a", amountMinor: 100 }], shares: [{ memberId: "b", amountMinor: 100 }] } },
      { operationId: "o", action: "create", entry: { kind: "payment", date: "2026-11-19", currency: "JPY", totalMinor: 10, senderId: "a", receiverId: "b", method: "Cash" } },
      { operationId: "o", action: "correct", entryId: "e", expectedVersion: 1, entry: expense },
      { operationId: "o", action: "void", entryId: "e", expectedVersion: 1 },
      { operationId: "o", action: "restore", entryId: "e", expectedVersion: 2 },
      { operationId: "o", action: "comment", entryId: "e", expectedVersion: 1, text: "Explanation" },
      { operationId: "o", action: "post", ruleId: "r", expectedRuleVersion: 1, period: 0, date: "2026-11-19", payers: [{ memberId: "a", amountMinor: 100 }] },
    ]) expect(ledgerCommandInput.safeParse(input).success).toBe(true);
  });
  it("rejects authority claims at every object boundary and malformed identity", () => {
    for (const value of [{ ...command, actorId: "x" }, { ...command, householdId: "x" }, { ...command, entry: { ...expense, authorId: "x" } }, { ...command, entry: { ...expense, payers: [{ memberId: "a", amountMinor: 100, role: "owner" }] } }, { ...command, operationId: "a b" }, { ...command, operationId: "x".repeat(129) }, { ...command, entry: { ...expense, payers: [{ memberId: " ", amountMinor: 100 }] } }]) expect(ledgerCommandInput.safeParse(value).success).toBe(false);
  });
  it("rejects broken financial intent, fake dates, empty text and excess fields", () => {
    for (const patch of [{ totalMinor: 0 }, { totalMinor: 10_000_000_001 }, { totalMinor: 1.5 }, { totalMinor: "100" }, { currency: "AUD" }, { date: "2026-02-30" }, { date: "0000-01-01" }, { date: "1900-02-29" }, { description: " " }, { description: "x".repeat(161) }, { notes: "x".repeat(2001) }, { category: "x".repeat(201) }, { payers: [{ memberId: "a", amountMinor: 99 }] }, { allocation: { kind: "split", split: { mode: "equal", participants: [{ memberId: "b", kind: "equal", actorId: "a" }] } } }]) expect(expenseInput.safeParse({ ...expense, ...patch }).success, JSON.stringify(patch)).toBe(false);
    expect(ledgerCommandInput.safeParse({ operationId: "o", action: "comment", entryId: "e", expectedVersion: 1, text: "x".repeat(2001) }).success).toBe(false);
    expect(ledgerCommandInput.safeParse({ operationId: "o", action: "create", entry: { kind: "payment", date: "2026-11-19", currency: "INR", totalMinor: 1, senderId: "a", receiverId: "a", method: "Cash" } }).success).toBe(false);
  });
  it("bounds raw UTF-8 bytes before JSON parsing", () => {
    expect(parseLedgerRequest(JSON.stringify(command))).toEqual(command);
    expect(() => parseLedgerRequest(" ".repeat(MAX_REQUEST_BYTES + 1))).toThrow();
    expect(() => parseLedgerRequest("😀".repeat(MAX_REQUEST_BYTES / 4 + 1))).toThrow();
    expect(() => parseLedgerRequest("{" )).toThrow();
  });
});

describe("future acceptance command guards", () => {
  it("requires the observed version on comments without accepting client attribution", () => {
    for (const extra of [{}, { expectedVersion: 0 }, { expectedVersion: 1, authorId: "a" }]) {
      expect(ledgerCommandInput.safeParse({ operationId: "o", action: "comment", entryId: "e", text: "Note", ...extra }).success).toBe(false);
    }
    expect(ledgerCommandInput.safeParse({ operationId: "o", action: "comment", entryId: "e", expectedVersion: 2, text: "Note" }).success).toBe(true);
  });
  it("takes safe nonnegative ordinal recurring periods, leaving cadence validity to acceptance", () => {
    const input = { operationId: "o", action: "post", ruleId: "r", expectedRuleVersion: 1, date: "2026-11-19", payers: [{ memberId: "a", amountMinor: 1 }] };
    for (const period of [0, 1, Number.MAX_SAFE_INTEGER]) expect(ledgerCommandInput.safeParse({ ...input, period }).success).toBe(true);
    for (const period of [-1, 0.5, "2026-11", Number.MAX_SAFE_INTEGER + 1]) expect(ledgerCommandInput.safeParse({ ...input, period }).success).toBe(false);
  });
  it("validates independent refund sides, nested unknown keys and immutable text bounds", () => {
    const entry = { kind: "refund", expenseId: "e", date: "2026-11-19", description: "Return", currency: "INR", totalMinor: 100, payers: [{ memberId: "a", amountMinor: 100 }], shares: [{ memberId: "b", amountMinor: 100 }] };
    for (const patch of [{ shares: [{ memberId: "b", amountMinor: 99 }] }, { payers: [{ memberId: "a", amountMinor: 50 }, { memberId: "a", amountMinor: 50 }] }, { shares: [{ memberId: "b", amountMinor: 100, householdId: "h" }] }]) expect(ledgerCommandInput.safeParse({ operationId: "o", action: "create", entry: { ...entry, ...patch } }).success).toBe(false);
    expect(() => parseLedgerRequest(new Uint8Array([255]))).toThrow();
    expect(ledgerCommandInput.safeParse({ ...command, entry: { ...expense, allocation: { kind: "itemized", participantOrder: ["b"], items: [{ label: "x", unitPriceMinor: 100, quantity: "1", split: { mode: "equal", participants: [{ memberId: "b", kind: "equal" }] }, actorId: "a" }] } } }).success).toBe(false);
  });
});

describe("Gregorian dates", () => {
  it("accepts Gregorian leap days and the inclusive final four-digit year", () => {
    expect(expenseInput.safeParse({ ...expense, date: "2000-02-29" }).success).toBe(true);
    expect(expenseInput.safeParse({ ...expense, date: "9999-12-31" }).success).toBe(true);
  });
});
