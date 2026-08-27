import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FullOrganization, HomeSessionContext } from "@/lib/auth-client";
import { OrganizationSettings } from "./organization-settings";

const authMocks = vi.hoisted(() => ({
  loadFullOrganization: vi.fn(),
  authRequest: vi.fn(),
  postAuth: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  loadFullOrganization: authMocks.loadFullOrganization,
  authRequest: authMocks.authRequest,
  postAuth: authMocks.postAuth,
}));

const organization: FullOrganization = {
  id: "org-1",
  name: "Flat 12",
  slug: "flat-12",
  members: [{
    id: "member-1",
    userId: "user-1",
    role: "member",
    user: { id: "user-1", name: "Dhruv", email: "dhruv@example.com" },
  }],
  invitations: [],
  teams: [],
};

function session(role: "member" | "admin"): HomeSessionContext {
  return {
    authenticated: true,
    user: { id: "user-1", name: "Dhruv", email: "dhruv@example.com" },
    activeOrganization: { id: "org-1", name: "Flat 12", slug: "flat-12" },
    membership: { id: "member-1", role },
    household: { id: "home-1", name: "Flat 12", organizationId: "org-1" },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrganizationSettings", () => {
  it("keeps management controls hidden from ordinary members", async () => {
    authMocks.loadFullOrganization.mockResolvedValue(organization);

    render(<OrganizationSettings session={session("member")} onBack={vi.fn()} />);

    expect(await screen.findByText("You are a member of this home.")).toBeInTheDocument();
    expect(screen.getByText("dhruv@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create group" })).not.toBeInTheDocument();
  });

  it("shows invitation and group management to admins", async () => {
    authMocks.loadFullOrganization.mockResolvedValue(organization);

    render(<OrganizationSettings session={session("admin")} onBack={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Create invite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create group" })).toBeInTheDocument();
    expect(screen.queryByText("You are a member of this home.")).not.toBeInTheDocument();
  });
});
