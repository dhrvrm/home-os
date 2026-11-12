import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMember, getMembers, resetMemberPassword, updateMember } from "@/lib/auth";
import { MembersView } from "./members-view";

vi.mock("@/lib/auth", () => ({ createMember: vi.fn(), getMembers: vi.fn(), resetMemberPassword: vi.fn(), updateMember: vi.fn() }));
const owner = { id: "owner", householdId: "home", name: "Asha", email: "asha@example.com", role: "owner" as const };
const members = [
  { ...owner, active: true, hasLogin: true },
  { id: "ravi", name: "Ravi", email: "ravi@example.com", role: "member" as const, active: true, hasLogin: true },
  { id: "priya", name: "Priya", email: "priya@example.com", role: "member" as const, active: false, hasLogin: true },
];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getMembers).mockResolvedValue(members); });
afterEach(cleanup);

async function ready() { render(<MembersView currentUser={owner} />); await screen.findByRole("article", { name: "Ravi" }); }

describe("MembersView", () => {
  it("lists members and retains departed members with their access status", async () => {
    await ready();
    expect(within(screen.getByRole("article", { name: "Ravi" })).getByText("Active")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Priya" })).getByText("Inactive")).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Asha" })).queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });

  it("gives nonowners a read-only roster", async () => {
    render(<MembersView currentUser={{ ...owner, id: "ravi", role: "member" }} />);
    await screen.findByRole("article", { name: "Ravi" });
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByText(/Household owners manage/)).toBeInTheDocument();
  });

  it("creates a member with an email and initial password", async () => {
    vi.mocked(createMember).mockResolvedValue({ id: "new", name: "Neha", email: "neha@example.com", role: "member", active: true, hasLogin: true });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Add member" }));
    const form = screen.getByRole("form", { name: "Add household member" });
    await userEvent.type(within(form).getByLabelText("Name"), "Neha");
    await userEvent.type(within(form).getByLabelText("Email"), "neha@example.com");
    await userEvent.type(within(form).getByLabelText("Initial password"), "a-long-password");
    await userEvent.type(within(form).getByLabelText("Confirm initial password"), "a-long-password");
    await userEvent.click(within(form).getByRole("button", { name: "Create member" }));
    expect(createMember).toHaveBeenCalledWith({ name: "Neha", email: "neha@example.com", password: "a-long-password", role: "member" });
    expect(await screen.findByRole("status")).toHaveTextContent("Neha can now sign in");
  });

  it("requires confirmation before deactivating a member", async () => {
    vi.mocked(updateMember).mockResolvedValue({ ...members[1], active: false });
    await ready();
    const row = screen.getByRole("article", { name: "Ravi" });
    await userEvent.click(within(row).getByRole("button", { name: "Deactivate" }));
    expect(updateMember).not.toHaveBeenCalled();
    expect(within(row).getByText(/Their sessions will end/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Deactivate Ravi" }));
    expect(updateMember).toHaveBeenCalledWith("ravi", { active: false });
  });

  it("resets a password without sending mismatched confirmation", async () => {
    vi.mocked(resetMemberPassword).mockResolvedValue(undefined);
    await ready();
    const row = screen.getByRole("article", { name: "Ravi" });
    await userEvent.click(within(row).getByRole("button", { name: "Reset password" }));
    await userEvent.type(within(row).getByLabelText("New password for Ravi"), "a-new-password");
    await userEvent.type(within(row).getByLabelText("Confirm new password for Ravi"), "different-password");
    await userEvent.click(within(row).getByRole("button", { name: "Save new password" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(resetMemberPassword).not.toHaveBeenCalled();
    await userEvent.clear(within(row).getByLabelText("Confirm new password for Ravi"));
    await userEvent.type(within(row).getByLabelText("Confirm new password for Ravi"), "a-new-password");
    await userEvent.click(within(row).getByRole("button", { name: "Save new password" }));
    expect(resetMemberPassword).toHaveBeenCalledWith("ravi", "a-new-password");
  });

  it("offers a retry after a member-list failure", async () => {
    vi.mocked(getMembers).mockRejectedValueOnce(new Error("Connection failed."));
    render(<MembersView currentUser={owner} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection failed.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Ravi" })).toBeInTheDocument();
  });
});
