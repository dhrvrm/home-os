import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login, setupOwner } from "@/lib/auth";
import { AuthScreen } from "./auth-screen";

vi.mock("@/lib/auth", () => ({ login: vi.fn(), setupOwner: vi.fn() }));
const session = { user: { id: "owner", householdId: "home", name: "Asha", email: "asha@example.com", role: "owner" as const }, expiresAt: "2027-01-01T00:00:00Z" };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(login).mockResolvedValue(session); vi.mocked(setupOwner).mockResolvedValue(session); });
afterEach(cleanup);

describe("AuthScreen", () => {
  it("signs in with native password-manager fields and the chosen persistence", async () => {
    const accepted = vi.fn();
    render(<AuthScreen setupRequired={false} setupAvailable onAuthenticated={accepted} />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
    await userEvent.type(screen.getByLabelText("Email"), "asha@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.click(screen.getByLabelText("Keep me signed in"));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(login).toHaveBeenCalledWith({ email: "asha@example.com", password: "my-long-password", remember: false });
    expect(accepted).toHaveBeenCalledWith(session);
  });

  it("preserves the form on a failed login so the member can retry", async () => {
    vi.mocked(login).mockRejectedValueOnce(new Error("Email or password is incorrect."));
    render(<AuthScreen setupRequired={false} setupAvailable onAuthenticated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email"), "asha@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    expect(screen.getByLabelText("Email")).toHaveValue("asha@example.com");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("my-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("shows an explicit password visibility control without changing its value", async () => {
    render(<AuthScreen setupRequired={false} setupAvailable onAuthenticated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("my-long-password");
  });

  it("requires matching setup passwords before establishing the owner", async () => {
    render(<AuthScreen setupRequired setupAvailable onAuthenticated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Your name"), "Asha");
    await userEvent.type(screen.getByLabelText("Email"), "asha@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "different-password");
    await userEvent.type(screen.getByLabelText("Home setup code"), "trusted-setup-code");
    await userEvent.click(screen.getByRole("button", { name: "Set up your home" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passwords do not match.");
    expect(setupOwner).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("Confirm password"));
    await userEvent.type(screen.getByLabelText("Confirm password"), "my-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Set up your home" }));
    expect(setupOwner).toHaveBeenCalledWith({ name: "Asha", email: "asha@example.com", password: "my-long-password", setupToken: "trusted-setup-code", remember: true });
  });

  it("explains unavailable setup and prevents an unusable submit", () => {
    render(<AuthScreen setupRequired setupAvailable={false} onAuthenticated={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("setup");
    expect(screen.queryByRole("button", { name: "Set up your home" })).not.toBeInTheDocument();
  });

  it("can sign in after a setup response was lost and retry reports an existing home", async () => {
    vi.mocked(setupOwner).mockRejectedValueOnce(new Error("This home is already set up. Sign in instead."));
    render(<AuthScreen setupRequired setupAvailable onAuthenticated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Your name"), "Asha");
    await userEvent.type(screen.getByLabelText("Email"), "asha@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.type(screen.getByLabelText("Confirm password"), "my-long-password");
    await userEvent.type(screen.getByLabelText("Home setup code"), "trusted-setup-code");
    await userEvent.click(screen.getByRole("button", { name: "Set up your home" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already set up");
    await userEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    expect(screen.getByLabelText("Email")).toHaveValue("asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(login).toHaveBeenCalledWith({ email: "asha@example.com", password: "my-long-password", remember: true });
  });

  it("shows rejected local reconciliation and keeps credentials for retry", async () => {
    render(<AuthScreen setupRequired={false} setupAvailable message="Sign in again to keep your saved changes." onAuthenticated={vi.fn().mockRejectedValue(new Error("Finish saving local changes first."))} />);
    await userEvent.type(screen.getByLabelText("Email"), "asha@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "my-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Finish saving local changes first.");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("my-long-password");
  });
});
