import { addRational, decimalMoney, divideRational, LedgerMoneyError, multiplyRational, rational, roundRationalMinor, type Currency, type Rational } from "../../../../shared/ledger-money";

export type CalculatorResult = { ok: true; amountMinor: number; display: string } | { ok: false; error: string };
type Value = { value: Rational; percent: boolean };
const HUNDRED = BigInt(100);
function invalid(message: string): never { throw new LedgerMoneyError("invalid_calculation", message); }

/** Recursive-descent arithmetic only: no executable expression evaluation. */
export function evaluateExpression(expression: string): Rational {
  if (expression.length > 128) invalid("Use at most 128 characters");
  const tokens: string[] = [];
  const pattern = /\s*(\d+(?:\.\d+)?|\.\d+|[()+\-*/%])/y;
  let offset = 0;
  while (offset < expression.length) {
    if (!expression.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) invalid("Use numbers, parentheses and arithmetic operators only");
    tokens.push(match[1]!); offset = pattern.lastIndex;
    if (tokens.length > 64) invalid("Use at most 64 calculation tokens");
  }
  if (tokens.length === 0) invalid("Enter an amount calculation");
  let position = 0;
  function consume(token: string): boolean { if (tokens[position] !== token) return false; position++; return true; }
  function addition(depth: number): Value {
    let left = multiplication(depth);
    while (tokens[position] === "+" || tokens[position] === "-") {
      const subtract = tokens[position++] === "-";
      const right = multiplication(depth);
      const delta = right.percent ? multiplyRational(left.value, right.value) : right.value;
      left = { value: addRational(left.value, subtract ? rational(-delta.numerator, delta.denominator) : delta), percent: false };
    }
    return left;
  }
  function multiplication(depth: number): Value {
    let left = unary(depth);
    while (tokens[position] === "*" || tokens[position] === "/") {
      const divide = tokens[position++] === "/";
      const right = unary(depth);
      left = { value: divide ? divideRational(left.value, right.value) : multiplyRational(left.value, right.value), percent: false };
    }
    return left;
  }
  function unary(depth: number): Value {
    if (consume("+")) return unary(depth);
    if (consume("-")) { const item = unary(depth); return { value: rational(-item.value.numerator, item.value.denominator), percent: item.percent }; }
    return primary(depth);
  }
  function primary(depth: number): Value {
    let result: Value;
    if (consume("(")) {
      if (depth >= 8) invalid("Use at most eight nested parentheses");
      result = addition(depth + 1);
      if (!consume(")")) invalid("Close the calculation parentheses");
    } else {
      const token = tokens[position++];
      if (!token || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) invalid("Enter a number or parenthesized calculation");
      const [whole = "0", fraction = ""] = token.split(".");
      const numerator = BigInt((whole || "0") + fraction);
      if (BigInt(whole || "0") > BigInt(Number.MAX_SAFE_INTEGER)) invalid("A literal exceeds the safe integer limit");
      result = { value: rational(numerator, BigInt(10) ** BigInt(fraction.length)), percent: false };
    }
    if (consume("%")) result = { value: divideRational(result.value, rational(HUNDRED)), percent: true };
    return result;
  }
  const result = addition(0);
  if (position !== tokens.length) invalid("Check the calculation operators");
  return result.value;
}

/** Applying only produces input text; the receiving amount field enforces its own domain. */
export function calculateAmount(expression: string, currency: Currency): CalculatorResult {
  try {
    const amountMinor = roundRationalMinor(evaluateExpression(expression), currency);
    return { ok: true, amountMinor, display: decimalMoney(amountMinor, currency) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Check the calculation" };
  }
}
