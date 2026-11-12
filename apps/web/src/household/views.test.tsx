import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError, request } from "@/lib/api";
import {
  publishAccessBoundary,
  resumeHouseholdWork,
  setActiveMemberId,
} from "@/auth/work";
import type { AuthUser } from "@/lib/auth";
import type { Meal, Recipe, Contact } from "./types";
import { MenuView } from "./menu-view";
import { RecipesView } from "./recipes-view";
import { ContactsView, emailHref, phoneHref } from "./contacts-view";
import { readCopy, writeCopy } from "./cache";
import { NotificationsView } from "./notifications-view";
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  request: vi.fn(),
  listItems: vi.fn(async () => []),
}));
vi.mock("./cache", () => ({
  readCopy: vi.fn(async () => null),
  writeCopy: vi.fn(async (_user, _domain, data) => ({
    data,
    savedAt: "2026-11-12T00:00:00Z",
    cached: false,
  })),
}));
const user: AuthUser = {
  id: "me",
  householdId: "home",
  role: "member",
  name: "Me",
  email: "me@example.com",
};
const recipe: Recipe = {
  id: "rice",
  householdId: "home",
  name: "Rice",
  description: "",
  servings: 4,
  ingredients: [
    { name: "Rice", quantity: 1, unit: "cup", inventoryItemId: null },
  ],
  instructions: "Rinse\nCook",
  labels: [],
  version: 1,
  archivedAt: null,
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  availability: {
    state: "unknown",
    ingredients: [
      {
        index: 0,
        state: "unknown",
        reason: "Not linked",
        inventoryItemId: null,
        availableQuantity: null,
        unit: "",
      },
    ],
  },
};
const meal: Meal = {
  id: "dinner",
  householdId: "home",
  title: "Dinner",
  cookingAt: "2099-11-12T14:00:00Z",
  timezone: "Asia/Kolkata",
  reminderMinutesBefore: 60,
  reminderAt: "2099-11-12T13:00:00Z",
  notes: "Keep warm",
  recipes: [{ ...recipe, sourceRecipeId: recipe.id, sourceRecipeVersion: 1 }],
  status: "scheduled",
  version: 2,
  announcementVersion: 1,
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  attendance: {
    counts: { yes: 0, no: 0, pending: 1, total: 1 },
    participants: [
      {
        memberId: "me",
        memberName: "Me",
        response: "pending",
        announcementVersion: 0,
        responseVersion: 0,
        needsReconfirmation: false,
        updatedAt: null,
      },
    ],
  },
  myAttendance: {
    memberId: "me",
    memberName: "Me",
    response: "pending",
    announcementVersion: 0,
    responseVersion: 0,
    needsReconfirmation: false,
    updatedAt: null,
  },
};
const contact: Contact = {
  id: "cook",
  householdId: "home",
  name: "Asha",
  role: "Cook",
  phone: "+91 98765 43210",
  email: "asha@example.com",
  address: "",
  notes: "Call in the morning",
  labels: ["Kitchen"],
  version: 1,
  archivedAt: null,
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
};
const mock = vi.mocked(request);
function routes() {
  mock.mockImplementation(async (path, init) => {
    if (init?.method && init.method !== "GET") return {};
    if (path === "/api/v1/notifications/preferences")
      return { preferences: { mealReminders: true, pushEnabled: false } };
    if (path === "/api/v1/notifications/config")
      return { pushAvailable: true, publicKey: "AQAB" };
    if (path === "/api/v1/notifications/subscriptions/current")
      return { subscription: { enabled: false } };
    if (path === "/api/v1/notifications")
      return {
        notifications: [
          {
            id: "n",
            kind: "meal_attendance",
            title: "Dinner reminder",
            body: "Are you eating?",
            mealId: "dinner",
            announcementVersion: 1,
            url: "/?view=menu&meal=dinner",
            createdAt: "2026-11-12T00:00:00Z",
            readAt: null,
          },
        ],
        unreadCount: 1,
      };
    if (path.startsWith("/api/v1/recipes")) return { recipes: [recipe] };
    if (path.startsWith("/api/v1/contacts")) return { contacts: [contact] };
    if (path === "/api/v1/meals/dinner")
      return { meal, timezone: "Asia/Kolkata" };
    if (path.startsWith("/api/v1/meals?"))
      return { meals: [], timezone: "Asia/Kolkata" };
    throw new Error(`Unexpected request ${path}`);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resumeHouseholdWork();
  setActiveMemberId(user.id);
  publishAccessBoundary("ready", user);
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  routes();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("household views", () => {
  it("shows qualified stock evidence and preserves ingredient rows when one is removed", async () => {
    render(<RecipesView currentUser={user} onAddToMenu={vi.fn()} />);
    await screen.findByRole("article", { name: "Rice" });
    expect(screen.getByText("Stock not fully checked.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit recipe" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Add ingredient" }),
    );
    await userEvent.type(screen.getByLabelText("Ingredient 2 name"), "Salt");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove ingredient 1" }),
    );
    expect(screen.getByLabelText("Ingredient 1 name")).toHaveValue("Salt");
  });
  it("opens a fresh focused meal and submits only the admitted member's versioned answer", async () => {
    render(<MenuView currentUser={user} focusedMealId="dinner" />);
    const opened = await screen.findByRole("region", { name: "Opened meal" });
    await within(opened).findByRole("article", { name: "Dinner" });
    await userEvent.click(
      within(opened).getByRole("button", { name: "I’m eating" }),
    );
    await waitFor(() =>
      expect(mock).toHaveBeenCalledWith(
        "/api/v1/meals/dinner/attendance",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            response: "yes",
            announcementVersion: 1,
            expectedResponseVersion: 0,
          }),
        }),
      ),
    );
    expect(await screen.findByText("You’re marked as eating.")).toBeTruthy();
  });
  it("omits recipeIds for a notes-only meal edit", async () => {
    render(<MenuView currentUser={user} focusedMealId="dinner" />);
    await screen.findByRole("article", { name: "Dinner" });
    await userEvent.click(screen.getByRole("button", { name: "Edit meal" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Meal notes"));
    await userEvent.type(
      within(dialog).getByLabelText("Meal notes"),
      "New note",
    );
    expect(
      within(dialog).queryByText(
        "Changing the time or dishes asks everyone to confirm again.",
      ),
    ).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save meal" }),
    );
    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([path, init]) =>
            path === "/api/v1/meals/dinner" && init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const call = mock.mock.calls.find(
      ([path, init]) =>
        path === "/api/v1/meals/dinner" && init?.method === "PATCH",
    )!;
    expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty("recipeIds");
  });
  it("keeps a conflicting draft until the user explicitly reviews the current version", async () => {
    const original = mock.getMockImplementation()!;
    let patches = 0;
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/contacts/cook" && init?.method === "PATCH") {
        patches++;
        if (patches === 1) throw new APIError("Changed", "conflict");
        return {};
      }
      if (path === "/api/v1/contacts?archived=include")
        return {
          contacts: [{ ...contact, version: 2, notes: "Someone else’s note" }],
        };
      return original(path, init, options);
    });
    render(<ContactsView currentUser={user} />);
    await screen.findByRole("article", { name: "Asha" });
    await userEvent.click(screen.getByRole("button", { name: "Edit contact" }));
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.type(screen.getByLabelText("Notes"), "My draft");
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await screen.findByText(/This record changed/);
    expect(screen.getByLabelText("Notes")).toHaveValue("My draft");
    expect(screen.getByRole("button", { name: "Save contact" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Review current record" }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "I reviewed the changes — keep my draft",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await waitFor(() => expect(patches).toBe(2));
    const saves = mock.mock.calls.filter(
      ([path, init]) =>
        path === "/api/v1/contacts/cook" && init?.method === "PATCH",
    );
    expect(saves[1][1]?.headers).toMatchObject({ "If-Match": "2" });
    expect(JSON.parse(String(saves[1][1]?.body)).notes).toBe("My draft");
  });
  it("has safe channel links and removes editing controls on a viewer role change", async () => {
    const view = render(<ContactsView currentUser={user} />);
    await screen.findByRole("article", { name: "Asha" });
    expect(screen.getByRole("link", { name: "Call Asha" })).toHaveAttribute(
      "href",
      "tel:+919876543210",
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit contact" }));
    view.rerender(<ContactsView currentUser={{ ...user, role: "viewer" }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull();
    expect(phoneHref("javascript:alert(1)")).toBeUndefined();
    expect(emailHref("a@b.com?subject=bad")).toBeUndefined();
  });
  it("blocks another preference change until the accepted settings are refreshed", async () => {
    const original = mock.getMockImplementation()!;
    const writes: unknown[] = [];
    let reads = 0;
    let current = { mealReminders: true, pushEnabled: true };
    let release: ((value: unknown) => void) | undefined;
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/notifications/preferences") {
        if (init?.method === "PUT") {
          current = JSON.parse(String(init.body));
          writes.push(current);
          return { preferences: current };
        }
        reads++;
        if (reads === 2)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { preferences: current };
      }
      return original(path, init, options);
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    const mealSetting = await screen.findByRole("checkbox", {
      name: "Meal reminders (inbox and push)",
    });
    const pushSetting = screen.getByRole("checkbox", {
      name: "Allow push delivery across my registered devices",
    });
    await waitFor(() => expect(mealSetting).not.toBeDisabled());
    await userEvent.click(mealSetting);
    await screen.findByText("Reminder preferences saved.");
    await waitFor(() => expect(release).toBeDefined());
    expect(pushSetting).toBeDisabled();
    await act(async () => release!({ preferences: current }));
    await waitFor(() => expect(pushSetting).not.toBeDisabled());
    expect(mealSetting).not.toBeChecked();
    await userEvent.click(pushSetting);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ mealReminders: false, pushEnabled: false });
  });
  it("keeps preference-dependent writes disabled after a failed refresh until retry succeeds", async () => {
    const original = mock.getMockImplementation()!;
    let reads = 0;
    let current = { mealReminders: true, pushEnabled: false };
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn(),
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/notifications/preferences") {
        if (init?.method === "PUT") {
          current = JSON.parse(String(init.body));
          return { preferences: current };
        }
        if (++reads === 2)
          throw new APIError("Refresh disconnected", "network_error");
        return { preferences: current };
      }
      return original(path, init, options);
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    const setting = await screen.findByRole("checkbox", {
      name: "Meal reminders (inbox and push)",
    });
    await waitFor(() => expect(setting).not.toBeDisabled());
    await userEvent.click(setting);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(setting).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "Allow push delivery across my registered devices",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Enable push notifications" }),
    ).toBeDisabled();
    await userEvent.click(retry);
    await waitFor(() => expect(setting).not.toBeDisabled());
    expect(setting).not.toBeChecked();
  });
  it.each([false, true])(
    "repairs a rotated sender key only after a gesture, and reuses a matching key (%s)",
    async (sameKey) => {
      const permission = vi.fn(async () => "granted" as const);
      vi.stubGlobal("Notification", {
        permission: "granted",
        requestPermission: permission,
      });
      vi.stubGlobal("PushManager", function PushManager() {});
      const native = {
        endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
        keys: { p256dh: "public", auth: "secret" },
      };
      const unsubscribe = vi.fn(async () => true);
      const existing = {
        options: {
          applicationServerKey: new Uint8Array(sameKey ? [1, 0, 1] : [9, 9, 9])
            .buffer,
        },
        unsubscribe,
        toJSON: () => native,
      };
      const subscribe = vi.fn(async () => ({ toJSON: () => native }));
      const registration = {
        pushManager: { getSubscription: async () => existing, subscribe },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      });
      const original = mock.getMockImplementation()!;
      mock.mockImplementation(async (path, init, options) => {
        if (path === "/api/v1/notifications/preferences" && !init?.method)
          return { preferences: { mealReminders: true, pushEnabled: true } };
        if (
          path === "/api/v1/notifications/subscriptions/current" &&
          !init?.method
        )
          return { subscription: { enabled: true } };
        return original(path, init, options);
      });
      render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
      const button = await screen.findByRole("button", {
        name: sameKey
          ? "Refresh push notifications"
          : "Update push notifications",
      });
      await waitFor(() => expect(button).not.toBeDisabled());
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      expect(permission).not.toHaveBeenCalled();
      await userEvent.click(button);
      await screen.findByText("Push notifications enabled on this device.");
      expect(unsubscribe).toHaveBeenCalledTimes(sameKey ? 0 : 1);
      expect(subscribe).toHaveBeenCalledTimes(sameKey ? 0 : 1);
      expect(mock).toHaveBeenCalledWith(
        "/api/v1/notifications/subscriptions/current",
        expect.objectContaining({ method: "PUT" }),
      );
    },
  );
  it("never prompts on load, and permission alone does not claim device registration", async () => {
    const permission = vi.fn(async () => "denied" as const);
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: permission,
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    await screen.findByRole("article", { name: "Dinner reminder" });
    expect(permission).not.toHaveBeenCalled();
    expect(screen.queryByText("Enabled on this device")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("does not expose the previous member's accepted entries after a switch", async () => {
    const view = render(<ContactsView currentUser={user} />);
    await screen.findByRole("article", { name: "Asha" });
    const other = { ...user, id: "other" };
    setActiveMemberId(other.id);
    publishAccessBoundary("ready", other);
    mock.mockImplementation(() => new Promise(() => {}));
    view.rerender(<ContactsView currentUser={other} />);
    expect(screen.queryByRole("article", { name: "Asha" })).toBeNull();
  });
  it("requests permission only from the enable gesture and registers before enabling delivery", async () => {
    const order: string[] = [];
    const permission = vi.fn(async () => {
      order.push("permission");
      return "granted" as const;
    });
    const native = {
      endpoint: "https://push.example/sub",
      keys: { p256dh: "public", auth: "secret" },
    };
    const subscribe = vi.fn(async () => ({ toJSON: () => native }));
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: permission,
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => null, subscribe },
        }),
      },
    });
    const original = mock.getMockImplementation()!;
    mock.mockImplementation(async (path, init, options) => {
      if (init?.method === "PUT") order.push(path);
      return original(path, init, options);
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    const button = await screen.findByRole("button", {
      name: "Enable push notifications",
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(permission).not.toHaveBeenCalled();
    await userEvent.click(button);
    await screen.findByText("Push notifications enabled on this device.");
    expect(order).toEqual([
      "permission",
      "/api/v1/notifications/subscriptions/current",
      "/api/v1/notifications/preferences",
    ]);
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(
      vi
        .mocked(writeCopy)
        .mock.calls.some((call) =>
          JSON.stringify(call[2]).includes("push.example"),
        ),
    ).toBe(false);
  });
  it("keeps the inbox useful when the permission gesture is denied", async () => {
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(async () => "denied" as const),
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({}) },
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    const enable = await screen.findByRole("button", {
      name: "Enable push notifications",
    });
    await waitFor(() => expect(enable).not.toBeDisabled());
    await userEvent.click(enable);
    await screen.findByText(/Notifications are blocked/);
    expect(screen.getByRole("button", { name: "Open meal" })).toBeEnabled();
    expect(mock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
  });
  it("does not register a subscription after identity changes during permission", async () => {
    let grant!: (value: NotificationPermission) => void;
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(
        () =>
          new Promise<NotificationPermission>((resolve) => {
            grant = resolve;
          }),
      ),
    });
    vi.stubGlobal("PushManager", function PushManager() {});
    const subscribe = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => null, subscribe },
        }),
      },
    });
    render(<NotificationsView currentUser={user} onOpenMeal={vi.fn()} />);
    const enable = await screen.findByRole("button", {
      name: "Enable push notifications",
    });
    await waitFor(() => expect(enable).not.toBeDisabled());
    await userEvent.click(enable);
    const other = { ...user, id: "other" };
    setActiveMemberId(other.id);
    publishAccessBoundary("ready", other);
    grant("granted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscribe).not.toHaveBeenCalled();
    expect(mock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      false,
    );
    expect(
      screen.queryByText("Push notifications enabled on this device."),
    ).toBeNull();
  });
  it("schedules multiple dishes at the household wall-clock time", async () => {
    const original = mock.getMockImplementation()!;
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/recipes")
        return { recipes: [recipe, { ...recipe, id: "dal", name: "Dal" }] };
      return original(path, init, options);
    });
    render(<MenuView currentUser={user} prefillRecipeId="rice" />);
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByLabelText("Dal");
    await userEvent.click(within(dialog).getByLabelText("Dal"));
    fireEvent.change(
      within(dialog).getByLabelText("Cooking date and time · Asia/Kolkata"),
      { target: { value: "2099-11-13T19:30" } },
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save meal" }),
    );
    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([path, init]) => path === "/api/v1/meals" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const call = mock.mock.calls.find(
      ([path, init]) => path === "/api/v1/meals" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      recipeIds: ["rice", "dal"],
      cookingAt: "2099-11-13T14:00:00.000Z",
      timezone: "Asia/Kolkata",
      reminderMinutesBefore: 60,
    });
  });
  it("retains a save operation ID across a timeout retry", async () => {
    const original = mock.getMockImplementation()!;
    let saves = 0;
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/contacts/cook" && init?.method === "PATCH") {
        saves++;
        if (saves === 1) throw new APIError("Timed out", "timeout");
        return {};
      }
      return original(path, init, options);
    });
    render(<ContactsView currentUser={user} />);
    await screen.findByRole("article", { name: "Asha" });
    await userEvent.click(screen.getByRole("button", { name: "Edit contact" }));
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await screen.findByText("Timed out");
    await userEvent.click(screen.getByRole("button", { name: "Save contact" }));
    await waitFor(() => expect(saves).toBe(2));
    const calls = mock.mock.calls.filter(
      ([path, init]) =>
        path === "/api/v1/contacts/cook" && init?.method === "PATCH",
    );
    expect(calls[0][1]?.headers).toEqual(calls[1][1]?.headers);
  });
  it("shows a dated offline copy and disables shared writes", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    vi.mocked(readCopy).mockResolvedValueOnce({
      data: { contacts: [contact] },
      cached: true,
      savedAt: "2026-11-12T00:00:00Z",
    });
    render(<ContactsView currentUser={user} />);
    await screen.findByRole("article", { name: "Asha" });
    expect(screen.getByText(/Saved copy/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit contact" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add contact" })).toBeDisabled();
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns from inline recipe creation with the meal draft and new dish selected", async () => {
    const original = mock.getMockImplementation()!;
    let created = false;
    const dal = { ...recipe, id: "dal", name: "Dal" };
    mock.mockImplementation(async (path, init, options) => {
      if (path === "/api/v1/recipes" && init?.method === "POST") {
        created = true;
        return { recipe: dal };
      }
      if (path === "/api/v1/recipes") return { recipes: created ? [dal] : [] };
      return original(path, init, options);
    });
    render(<MenuView currentUser={user} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Schedule meal" }),
    );
    await userEvent.clear(screen.getByLabelText("Meal title"));
    await userEvent.type(screen.getByLabelText("Meal title"), "Friday feast");
    fireEvent.change(
      screen.getByLabelText("Cooking date and time · Asia/Kolkata"),
      { target: { value: "2099-11-13T19:30" } },
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a recipe for this meal" }),
    );
    await userEvent.type(screen.getByLabelText("Recipe name"), "Dal");
    await userEvent.type(screen.getByLabelText("Ingredient 1 name"), "Lentils");
    await userEvent.click(screen.getByRole("button", { name: "Save recipe" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Meal title")).toHaveValue("Friday feast"),
    );
    expect(
      screen.getByLabelText("Cooking date and time · Asia/Kolkata"),
    ).toHaveValue("2099-11-13T19:30");
    expect(await screen.findByLabelText("Dal")).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save meal" }));
    await waitFor(() =>
      expect(
        mock.mock.calls.some(
          ([path, init]) => path === "/api/v1/meals" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const call = mock.mock.calls.find(
      ([path, init]) => path === "/api/v1/meals" && init?.method === "POST",
    )!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      title: "Friday feast",
      recipeIds: ["dal"],
      cookingAt: "2099-11-13T14:00:00.000Z",
    });
  });
});
