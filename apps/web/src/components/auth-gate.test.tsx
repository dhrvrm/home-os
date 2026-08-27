import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeSessionContext } from "@/lib/auth-client";
import { AuthGate } from "./auth-gate";

const authMocks = vi.hoisted(() => ({
  loadHomeSession: vi.fn(),
  postAuth: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: authMocks.signOut },
  loadHomeSession: authMocks.loadHomeSession,
  postAuth: authMocks.postAuth,
  organizationSlug: (name: string) => `${name.toLowerCase()}-test`,
}));

vi.mock("./inventory-app", () => ({
  InventoryApp: ({ householdId, actorId, homeName }: { householdId: string; actorId: string; homeName: string }) => (
    <div data-testid="inventory">{householdId}|{actorId}|{homeName}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthGate", () => {
  it("shows Google sign-in when there is no session", async () => {
    authMocks.loadHomeSession.mockResolvedValue({ authenticated: false } satisfies HomeSessionContext);

    render(<AuthGate />);

    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.queryByTestId("inventory")).not.toBeInTheDocument();
  });

  it("requires organization onboarding before inventory opens", async () => {
    authMocks.loadHomeSession.mockResolvedValue({
      authenticated: true,
      user: { id: "user-1", name: "Dhruv", email: "dhruv@example.com" },
      organizations: [],
      activeOrganization: null,
      membership: null,
      household: null,
    } satisfies HomeSessionContext);

    render(<AuthGate />);

    expect(await screen.findByRole("heading", { name: "Choose the home you want to open." })).toBeInTheDocument();
    expect(screen.getByLabelText("Name your first home")).toBeInTheDocument();
  });

  it("passes the authenticated household and member identity to inventory", async () => {
    authMocks.loadHomeSession.mockResolvedValue({
      authenticated: true,
      user: { id: "user-1", name: "Dhruv", email: "dhruv@example.com" },
      organizations: [{ id: "org-1", name: "Flat 12", slug: "flat-12" }],
      activeOrganization: { id: "org-1", name: "Flat 12", slug: "flat-12" },
      membership: { id: "member-1", role: "owner" },
      household: { id: "home-1", name: "Flat 12", organizationId: "org-1" },
    } satisfies HomeSessionContext);

    render(<AuthGate />);

    expect(await screen.findByTestId("inventory")).toHaveTextContent("home-1|member-1|Flat 12");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
