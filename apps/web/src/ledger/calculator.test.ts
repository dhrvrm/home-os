import { describe, expect, it } from "vitest";
import { calculateAmount, evaluateExpression } from "./calculator";
import { rational, roundRationalMinor } from "../../../../shared/ledger-money";

describe("bounded rational amount calculator", () => {
  for (const [expression, expected] of [["2+3*4", 1400], ["(2+3)*4", 2000], ["--2", 200], ["100+10%", 11000], ["100-10%", 9000], ["250*18%", 4500], ["100/10%", 100000], ["10%", 10], ["1/3*3", 100], ["-1.005", -101], ["1.005", 101], ["100+(5+5)%", 11000], ["100+-10%", 9000], ["100+10%+10%", 12100]] as const) {
    it(expression, () => expect(calculateAmount(expression, "INR")).toEqual({ ok: true, amountMinor: expected, display: `${expected < 0 ? "-" : ""}${Math.floor(Math.abs(expected) / 100)}.${String(Math.abs(expected) % 100).padStart(2, "0")}` }));
  }
  it("rounds to selected precision only when applied", () => {
    expect(evaluateExpression("1/3*3")).toEqual({ numerator: BigInt(1), denominator: BigInt(1) });
    expect(calculateAmount("2.5", "JPY")).toEqual({ ok: true, amountMinor: 3, display: "3" });
    expect(calculateAmount("-2.5", "JPY")).toEqual({ ok: true, amountMinor: -3, display: "-3" });
    expect(calculateAmount("0", "USD")).toEqual({ ok: true, amountMinor: 0, display: "0.00" });
  });
  it("recovers from syntax, division, input, token, depth, magnitude and bit-size refusals", () => {
    for (const expression of ["1/0", "alert(1)", "2**3", "1e3", "", "1 2", "()", "2(3)", "1+", "1%%", "9".repeat(129), Array(34).fill("1").join("+"), "(".repeat(9) + "1" + ")".repeat(9), "9007199254740992", "100000000.01", "999999999999999999999999999999999999999999999999999999999999999*999999999999999999999999999999999999999999999999999999999999999"]) {
      expect(calculateAmount(expression, "USD"), expression).toMatchObject({ ok: false, error: expect.any(String) });
    }
    // Repeated rational division stays within all limits; tiny intermediates are not rounded early.
    expect(calculateAmount("1/" + Array(10).fill("999999999").join("/"), "INR")).toMatchObject({ ok: true });
    const huge = "9".repeat(110);
    expect(calculateAmount(`${huge}*9999999999999999`, "JPY")).toMatchObject({ ok: false });
  });
});

describe("calculator precision and complexity edges", () => {
  it("accepts exact configured character, token and nesting boundaries", () => {
    expect(calculateAmount(" ".repeat(127) + "1", "INR")).toMatchObject({ ok: true, amountMinor: 100 });
    expect(calculateAmount("+".repeat(63) + "1", "INR")).toMatchObject({ ok: true, amountMinor: 100 });
    expect(calculateAmount("(".repeat(8) + "1" + ")".repeat(8), "JPY")).toMatchObject({ ok: true, amountMinor: 1 });
    expect(calculateAmount("+".repeat(64) + "1", "INR")).toMatchObject({ ok: false });
  });
  it("recomputes the same major-unit expression for each selected currency", () => {
    expect(calculateAmount("1.49", "USD")).toMatchObject({ ok: true, amountMinor: 149, display: "1.49" });
    expect(calculateAmount("1.49", "JPY")).toMatchObject({ ok: true, amountMinor: 1, display: "1" });
    expect(calculateAmount("100000000", "INR")).toMatchObject({ ok: true, amountMinor: 10000000000 });
    expect(calculateAmount("-100000000", "INR")).toMatchObject({ ok: true, amountMinor: -10000000000 });
  });
  it("bounds every rational intermediate including currency scaling before rounding", () => {
    const high = BigInt(1) << BigInt(511);
    expect(() => rational(high * BigInt(2))).toThrow(/intermediate size/);
    expect(() => roundRationalMinor(rational(high - BigInt(1), high), "INR")).toThrow(/intermediate size/);
  });
});
