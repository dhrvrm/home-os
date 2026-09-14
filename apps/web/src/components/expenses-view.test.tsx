import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError, archiveExpense, createExpense, listExpenses, listMembers, restoreExpense, updateExpense } from "@/lib/api";
import type { ExpenseRule, Member } from "@/lib/expenses";
import { ExpensesView } from "./expenses-view";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    APIError: actual.APIError,
    listExpenses: vi.fn(),
    listMembers: vi.fn(),
    createExpense: vi.fn(),
    updateExpense: vi.fn(),
    archiveExpense: vi.fn(),
    restoreExpense: vi.fn(),
  };
});

const members: Member[] = [
  { id: "owner", name: "Asha", active: true },
  { id: "flatmate", name: "Ravi", active: true },
  { id: "departed", name: "Priya", active: false },
];

const electricity: ExpenseRule = {
  id: "electricity",
  householdId: "home",
  name: "Electricity",
  amountMinor: 500000,
  currency: "INR",
  cadence: { unit: "month", interval: 1, anchorDate: "2026-09-01" },
  participants: [
    { memberId: "owner", override: null, shareMinor: 250000, memberActive: true },
    { memberId: "flatmate", override: null, shareMinor: 250000, memberActive: true },
  ],
  needsAttention: false,
  version: 3,
  archivedAt: null,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
};

const internet: ExpenseRule = {
  ...electricity,
  id: "internet",
  name: "Internet",
  amountMinor: 120000,
  participants: [
    { memberId: "owner", override: null, shareMinor: 60000, memberActive: true },
    { memberId: "departed", override: null, shareMinor: 60000, memberActive: false },
  ],
  needsAttention: true,
  version: 1,
};

const listExpensesMock = vi.mocked(listExpenses);
const listMembersMock = vi.mocked(listMembers);
const createExpenseMock = vi.mocked(createExpense);
const updateExpenseMock = vi.mocked(updateExpense);
const archiveExpenseMock = vi.mocked(archiveExpense);
const restoreExpenseMock = vi.mocked(restoreExpense);

function activeAndArchived(active: ExpenseRule[], archived: ExpenseRule[] = []) {
  listExpensesMock.mockImplementation(async (options = {}) => (options.archived === "only" ? archived : active));
}

async function renderReady() {
  render(<ExpensesView />);
  await screen.findByRole("heading", { name: "Recurring expenses" });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMembersMock.mockResolvedValue(members);
  activeAndArchived([electricity, internet]);
});

afterEach(cleanup);

describe("ExpensesView", () => {
  it("lists each rule with its amount, cadence, and resolved shares", async () => {
    await renderReady();

    const row = screen.getByRole("article", { name: "Electricity" });
    expect(within(row).getByText("₹5,000.00 · Every month from 1 Sept 2026")).toBeTruthy();
    expect(within(row).getByText("Asha · ₹2,500.00")).toBeTruthy();
    expect(within(row).getByText("Ravi · ₹2,500.00")).toBeTruthy();
  });

  it("flags a rule whose participant is no longer active", async () => {
    await renderReady();

    const row = screen.getByRole("article", { name: "Internet" });
    expect(within(row).getByText(/Priya is no longer in the household/)).toBeTruthy();
  });

  it("renders an empty state with a way to create the first rule", async () => {
    activeAndArchived([]);
    await renderReady();

    expect(screen.getByText("No recurring expenses yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add your first expense" })).toBeTruthy();
  });

  it("renders an error state with a retry that reloads", async () => {
    listExpensesMock.mockRejectedValueOnce(new APIError("The Home OS API is unavailable.", "network_error"));
    render(<ExpensesView />);

    await screen.findByText("Expenses could not be loaded");
    activeAndArchived([electricity]);
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));

    expect(await screen.findByRole("article", { name: "Electricity" })).toBeTruthy();
  });

  it("previews the split locally and creates the rule with minor-unit amounts", async () => {
    activeAndArchived([]);
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "Add your first expense" }));

    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Expense name"), "Water");
    await userEvent.type(within(dialog).getByLabelText("Amount"), "1000");
    await userEvent.clear(within(dialog).getByLabelText("Starting from"));
    await userEvent.type(within(dialog).getByLabelText("Starting from"), "2026-10-01");
    await userEvent.click(within(dialog).getByLabelText("Asha"));
    await userEvent.click(within(dialog).getByLabelText("Ravi"));

    const preview = within(dialog).getByRole("region", { name: "Split preview" });
    expect(within(preview).getByText("Asha · ₹500.00")).toBeTruthy();
    expect(within(preview).getByText("Ravi · ₹500.00")).toBeTruthy();

    await userEvent.selectOptions(within(dialog).getByLabelText("Split for Asha"), "fixed");
    await userEvent.type(within(dialog).getByLabelText("Fixed amount for Asha"), "600");
    expect(within(preview).getByText("Asha · ₹600.00")).toBeTruthy();
    expect(within(preview).getByText("Ravi · ₹400.00")).toBeTruthy();
    expect(createExpenseMock).not.toHaveBeenCalled();

    const created: ExpenseRule = { ...electricity, id: "water", name: "Water", amountMinor: 100000 };
    createExpenseMock.mockResolvedValue(created);
    activeAndArchived([created]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save expense" }));

    await waitFor(() => expect(createExpenseMock).toHaveBeenCalled());
    expect(createExpenseMock.mock.calls[0]![0]).toEqual({
      name: "Water",
      amountMinor: 100000,
      currency: "INR",
      cadence: { unit: "month", interval: 1, anchorDate: "2026-10-01" },
      participants: [
        { memberId: "owner", override: { kind: "fixed", amountMinor: 60000 } },
        { memberId: "flatmate", override: null },
      ],
    });
    expect(createExpenseMock.mock.calls[0]![1]).toMatchObject({ operationId: expect.any(String) });
    expect(await screen.findByRole("article", { name: "Water" })).toBeTruthy();
  });

  it("refuses to submit a split the server would reject", async () => {
    activeAndArchived([]);
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "Add your first expense" }));

    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Expense name"), "Water");
    await userEvent.type(within(dialog).getByLabelText("Amount"), "1000");
    await userEvent.click(within(dialog).getByLabelText("Asha"));
    await userEvent.selectOptions(within(dialog).getByLabelText("Split for Asha"), "fixed");
    await userEvent.type(within(dialog).getByLabelText("Fixed amount for Asha"), "2000");

    expect(within(dialog).getByText("The fixed and percentage shares add up to more than the total.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save expense" }).hasAttribute("disabled")).toBe(true);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("pre-populates the edit dialog and guards the update with the rule version", async () => {
    await renderReady();
    const row = screen.getByRole("article", { name: "Electricity" });
    await userEvent.click(within(row).getByRole("button", { name: "Edit Electricity" }));

    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText("Expense name") as HTMLInputElement).value).toBe("Electricity");
    expect((within(dialog).getByLabelText("Amount") as HTMLInputElement).value).toBe("5000.00");

    updateExpenseMock.mockResolvedValue({ ...electricity, version: 4 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save expense" }));

    await waitFor(() => expect(updateExpenseMock).toHaveBeenCalled());
    expect(updateExpenseMock.mock.calls[0]![0]).toBe("electricity");
    expect(updateExpenseMock.mock.calls[0]![2]).toMatchObject({ expectedVersion: 3 });
  });

  it("keeps the dialog open on a conflict and rebases onto the refreshed version", async () => {
    await renderReady();
    await userEvent.click(within(screen.getByRole("article", { name: "Electricity" })).getByRole("button", { name: "Edit Electricity" }));

    const dialog = screen.getByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Expense name"));
    await userEvent.type(within(dialog).getByLabelText("Expense name"), "Power bill");

    updateExpenseMock.mockRejectedValueOnce(new APIError("This expense changed elsewhere.", "conflict"));
    activeAndArchived([{ ...electricity, version: 7 }, internet]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save expense" }));

    await within(dialog).findByText("This expense changed elsewhere.");
    expect((within(dialog).getByLabelText("Expense name") as HTMLInputElement).value).toBe("Power bill");

    updateExpenseMock.mockResolvedValue({ ...electricity, name: "Power bill", version: 8 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save expense" }));

    await waitFor(() => expect(updateExpenseMock).toHaveBeenCalledTimes(2));
    expect(updateExpenseMock.mock.calls[1]![2]).toMatchObject({ expectedVersion: 7 });
  });

  it("archives a rule after confirmation and restores it from the archived list", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderReady();

    archiveExpenseMock.mockResolvedValue({ ...electricity, archivedAt: "2026-09-14T10:00:00Z", version: 4 });
    activeAndArchived([internet], [{ ...electricity, archivedAt: "2026-09-14T10:00:00Z", version: 4 }]);
    await userEvent.click(within(screen.getByRole("article", { name: "Electricity" })).getByRole("button", { name: "Archive Electricity" }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("article", { name: "Electricity" })).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: /Archived/ }));
    const archivedRow = await screen.findByRole("article", { name: "Electricity" });

    restoreExpenseMock.mockResolvedValue(electricity);
    activeAndArchived([electricity, internet], []);
    await userEvent.click(within(archivedRow).getByRole("button", { name: "Restore Electricity" }));

    await waitFor(() => expect(restoreExpenseMock).toHaveBeenCalledWith("electricity", expect.anything()));
    confirmSpy.mockRestore();
  });
});
