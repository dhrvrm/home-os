import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { publishAccessBoundary, resumeHouseholdWork, setActiveMemberId } from "@/auth/work";
import type { AuthUser } from "@/lib/auth";
import { householdRead } from "./api";
import { useResource } from "./ui";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  householdRead: vi.fn(async (_user, domain) => ({ data: domain, savedAt: "2026-11-12T00:00:00Z", cached: false })),
}));
const user: AuthUser = { id: "me", householdId: "home", role: "member", name: "Me", email: "me@example.com" };
const valid = (value: unknown): value is string => typeof value === "string";
afterEach(() => vi.clearAllMocks());
it("revalidates the current query when an earlier mutation completes after a filter change", async () => {
  setActiveMemberId(user.id);
  resumeHouseholdWork();
  publishAccessBoundary("ready", user);
  const view = renderHook(({ domain }) => useResource(user, domain, `/contacts?${domain}`, valid), { initialProps: { domain: "archived" } });
  await waitFor(() => expect(view.result.current.copy?.data).toBe("archived"));
  const staleRefresh = view.result.current.refresh;
  view.rerender({ domain: "active" });
  await waitFor(() => expect(view.result.current.copy?.data).toBe("active"));
  const before = vi.mocked(householdRead).mock.calls.length;
  await act(async () => staleRefresh());
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.copy?.data).toBe("active");
  expect(vi.mocked(householdRead).mock.calls).toHaveLength(before + 1);
  expect(vi.mocked(householdRead).mock.calls.at(-1)?.[1]).toBe("active");
  view.unmount();
  await staleRefresh();
  expect(vi.mocked(householdRead).mock.calls).toHaveLength(before + 1);
});
