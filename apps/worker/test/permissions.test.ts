import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  permits,
  permitsHandoff,
  type Action,
  type Role,
} from "../src/auth/permissions";
const reads = [
  "ledger_list", "ledger_get", "ledger_history", "ledger_balances", "ledger_statements", "ledger_export",
  "inventory_list",
  "inventory_attention",
  "inventory_get",
  "inventory_events",
  "inventory_export",
  "activity_list",
  "expenses_list",
  "expenses_get",
  "recipes_list",
  "recipes_get",
  "meals_list",
  "meals_get",
  "contacts_list",
  "contacts_get",
  "members_list",
];
const owners = [
  "members_update",
  "member_access_setup",
  "member_password_reset",
];
const personal = [
  "home_context",
  "notifications_list",
  "notifications_mark_read",
  "notification_preferences_get",
  "notification_preferences_set",
  "notification_device_setup",
  "account_password_change",
  "connection_authorize",
  "session_logout",
];
const selfOrOwner = [
  "connections_list",
  "connections_revoke",
  "sessions_list",
  "sessions_revoke",
];
const direct = [
  "member_access_setup",
  "member_password_reset",
  "notification_device_setup",
  "account_password_change",
  "connection_authorize",
  "session_logout",
];
const roles: Role[] = ["owner", "member", "viewer"];
const identity = (role: Role, ceiling?: Role) => ({
  memberId: "actor",
  householdId: "home",
  role,
  kind: ceiling ? ("delegated" as const) : ("browser" as const),
  ceiling,
});
describe("single household action policy", () => {
  it.each(["unknown", "constructor", "__proto__"])(
    "fails closed for unknown action %s",
    (action) => {
      expect(
        permits(identity("owner"), action as Action, {
          householdId: "home",
          memberId: "actor",
        }),
      ).toBe(false);
    },
  );
  it("refuses delegated authority without an approved ceiling", () => {
    expect(
      permits(
        {
          memberId: "actor",
          householdId: "home",
          role: "owner",
          kind: "delegated",
        },
        "inventory_create",
        { householdId: "home" },
      ),
    ).toBe(false);
  });
  for (const action of Object.keys(ACTIONS) as Action[]) {
    it(`${action} intersects role, subject, household and approved ceiling`, () => {
      for (const role of roles)
        for (const memberId of ["actor", "other"]) {
          const own = memberId === "actor";
          const allowed =
            reads.includes(action) ||
            (owners.includes(action)
              ? role === "owner"
              : personal.includes(action)
                ? own
                : selfOrOwner.includes(action)
                  ? own || role === "owner"
                  : role !== "viewer" &&
                    (action !== "meal_attendance_set" || own));
          const subject = { householdId: "home", memberId };
          expect(permits(identity(role), action, subject)).toBe(allowed);
          expect(
            permits(identity(role), action, {
              householdId: "elsewhere",
              memberId,
            }),
          ).toBe(false);
          for (const ceiling of roles) {
            const ceilingAllowed =
              reads.includes(action) ||
              (owners.includes(action)
                ? ceiling === "owner"
                : personal.includes(action)
                  ? own
                  : selfOrOwner.includes(action)
                    ? own || ceiling === "owner"
                    : ceiling !== "viewer" &&
                      (action !== "meal_attendance_set" || own));
            expect(permits(identity(role, ceiling), action, subject)).toBe(
              allowed && ceilingAllowed && !direct.includes(action),
            );
          }
        }
    });
  }
  it("allows direct-interaction handoffs under the same role ceiling without allowing execution", () => {
    const subject = { householdId: "home", memberId: "actor" };
    for (const action of [
      "account_password_change",
      "notification_device_setup",
    ] as const) {
      expect(
        permitsHandoff(identity("viewer", "viewer"), action, subject),
      ).toBe(true);
      expect(permits(identity("viewer", "viewer"), action, subject)).toBe(
        false,
      );
      expect(
        permitsHandoff(identity("viewer", "viewer"), action, {
          ...subject,
          memberId: "other",
        }),
      ).toBe(false);
    }
    expect(
      permitsHandoff(
        identity("owner", "member"),
        "member_access_setup",
        subject,
      ),
    ).toBe(false);
    expect(
      permitsHandoff(
        identity("owner", "owner"),
        "member_access_setup",
        subject,
      ),
    ).toBe(true);
    expect(
      permitsHandoff(
        identity("viewer", "owner"),
        "member_password_reset",
        subject,
      ),
    ).toBe(false);
  });
});
