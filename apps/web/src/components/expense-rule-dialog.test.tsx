import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExpenseRuleDialog } from "./expense-rule-dialog";
afterEach(cleanup);
it("uses explicit calculator application in recurring-rule amounts without submitting or changing the resolver", () => {
  const submit = vi.fn(); render(<ExpenseRuleDialog members={[{ id: "alice", name: "Alice", active: true }]} pending={false} error={null} onClose={vi.fn()} onSubmit={submit} />);
  fireEvent.click(screen.getByRole("button", { name: "Calculate Amount" }));
  fireEvent.change(screen.getByLabelText("Calculation for Amount"), { target: { value: "500 + 10%" } }); fireEvent.keyDown(screen.getByLabelText("Calculation for Amount"), { key: "Enter" }); expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply INR 550.00" })); expect(screen.getByLabelText("Amount")).toHaveValue("550.00"); expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "JPY" } }); expect(screen.getByLabelText("Amount")).toHaveValue("550.00"); expect(screen.getByText(/no exchange conversion/)).toBeInTheDocument();
});
