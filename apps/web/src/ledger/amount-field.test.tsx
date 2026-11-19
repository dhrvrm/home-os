import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { AmountField } from "./amount-field";
import userEvent from "@testing-library/user-event";
afterEach(cleanup);
function Harness({ currency = "INR" as const }) { const [value, setValue] = useState("12.00"); return <form onSubmit={event => { event.preventDefault(); throw new Error("Calculator submitted financial form"); }}><AmountField label="Bill amount" value={value} currency={currency} onChange={setValue} /><button type="submit">Save</button></form>; }
it("applies explicitly, handles Enter without saving, and cancels without changing money", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Calculate Bill amount" }));
  const expression = screen.getByLabelText("Calculation for Bill amount");
  fireEvent.change(expression, { target: { value: "100 + 10%" } });
  fireEvent.keyDown(expression, { key: "Enter" });
  expect(screen.getByLabelText("Bill amount")).toHaveValue("12.00");
  fireEvent.click(screen.getByRole("button", { name: "Apply INR 110.00" }));
  expect(screen.getByLabelText("Bill amount")).toHaveValue("110.00");
  fireEvent.click(screen.getByRole("button", { name: "Calculate Bill amount" }));
  fireEvent.change(screen.getByLabelText("Calculation for Bill amount"), { target: { value: "3*9" } });
  fireEvent.keyDown(screen.getByLabelText("Calculation for Bill amount"), { key: "Escape" });
  expect(screen.getByLabelText("Bill amount")).toHaveValue("110.00");
  expect(screen.getByRole("button", { name: "Calculate Bill amount" })).toHaveFocus();
});
it("rejects invalid and negative applied values while recomputing currency precision", () => {
  const change = vi.fn();
  const { rerender } = render(<AmountField label="Price" value="1.50" currency="INR" onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Calculate Price" }));
  fireEvent.change(screen.getByLabelText("Calculation for Price"), { target: { value: "1/0" } });
  expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Calculation for Price"), { target: { value: "-1" } });
  expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Calculation for Price"), { target: { value: "1.5" } });
  rerender(<AmountField label="Price" value="1.50" currency="JPY" onChange={change} />);
  expect(screen.getByRole("button", { name: "Apply JPY 2" })).toBeEnabled();
  expect(change).not.toHaveBeenCalled();
});
it("keeps the Apply button keyboard-operable inside the one parent focus scope", async () => {
  const user = userEvent.setup(); render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Calculate Bill amount" }));
  await user.clear(screen.getByLabelText("Calculation for Bill amount")); await user.type(screen.getByLabelText("Calculation for Bill amount"), "20/2");
  screen.getByRole("button", { name: "Apply INR 10.00" }).focus(); await user.keyboard("{Enter}");
  expect(screen.getByLabelText("Bill amount")).toHaveValue("10.00");
});
