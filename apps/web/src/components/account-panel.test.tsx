import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changePassword } from "@/lib/auth";
import { AccountPanel } from "./account-panel";

vi.mock("@/lib/auth", () => ({ changePassword: vi.fn() }));
vi.mock("./pwa-controls", () => ({ PWAControls: () => <div>Install Home OS</div> }));
const session = { user: { id: "owner", householdId: "home", name: "Asha", email: "asha@example.com", role: "owner" as const }, expiresAt: "2027-01-01T00:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(changePassword).mockResolvedValue(session); });
afterEach(cleanup);

describe("AccountPanel", () => {
  it("shows the signed-in identity and reports a failed sign out", async () => {
    render(<AccountPanel session={session} onLogout={vi.fn().mockRejectedValue(new Error("Connect before signing out."))} onSessionChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Asha" })).toBeInTheDocument();
    expect(screen.getByText(/asha@example.com/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connect before signing out.");
  });

  it("rejects mismatched new passwords before changing credentials", async () => {
    render(<AccountPanel session={session} onLogout={vi.fn()} onSessionChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await userEvent.type(screen.getByLabelText("Current password"), "my-current-password");
    await userEvent.type(screen.getByLabelText("New password"), "my-new-password");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "different-password");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("changes a password and refreshes the session without retaining password fields", async () => {
    const changed = vi.fn();
    render(<AccountPanel session={session} onLogout={vi.fn()} onSessionChange={changed} />);
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await userEvent.type(screen.getByLabelText("Current password"), "my-current-password");
    await userEvent.type(screen.getByLabelText("New password"), "my-new-password");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "my-new-password");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(changePassword).toHaveBeenCalledWith({ currentPassword: "my-current-password", newPassword: "my-new-password" });
    expect(changed).toHaveBeenCalledWith(session);
    expect(await screen.findByRole("status")).toHaveTextContent("Password changed");
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
  });
});
