export const ROLES = ["owner", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const HOME_ACCESS_SCOPE = "home:access";
type Rule = {
  roles: readonly Role[];
  subject?: "self" | "self_or_owner";
  browserOnly?: boolean;
};
const everyone = ROLES;
const writers = ["owner", "member"] as const;
const read: Rule = { roles: everyone };
const write: Rule = { roles: writers };
const personal: Rule = { roles: everyone, subject: "self" };
const owner: Rule = { roles: ["owner"] };
/** Single policy for direct and connected callers; transports only select an action. */
export const ACTIONS = {
  home_context: personal,
  inventory_list: read,
  inventory_attention: read,
  inventory_get: read,
  inventory_events: read,
  inventory_export: read,
  inventory_create: write,
  inventory_update: write,
  inventory_stock: write,
  inventory_archive: write,
  inventory_restore: write,
  activity_list: read,
  expenses_list: read,
  expenses_get: read,
  expenses_create: write,
  expenses_update: write,
  expenses_archive: write,
  expenses_restore: write,
  recipes_list: read,
  recipes_get: read,
  recipes_create: write,
  recipes_update: write,
  recipes_archive: write,
  recipes_restore: write,
  meals_list: read,
  meals_get: read,
  meals_create: write,
  meals_update: write,
  meals_cancel: write,
  meal_attendance_set: { roles: writers, subject: "self" },
  contacts_list: read,
  contacts_get: read,
  contacts_create: write,
  contacts_update: write,
  contacts_archive: write,
  contacts_restore: write,
  notifications_list: personal,
  notifications_mark_read: personal,
  notification_preferences_get: personal,
  notification_preferences_set: personal,
  notification_device_setup: { ...personal, browserOnly: true },
  members_list: read,
  members_update: owner,
  member_access_setup: { ...owner, browserOnly: true },
  member_password_reset: { ...owner, browserOnly: true },
  account_password_change: { ...personal, browserOnly: true },
  connections_list: { roles: everyone, subject: "self_or_owner" },
  connections_revoke: { roles: everyone, subject: "self_or_owner" },
  sessions_list: { roles: everyone, subject: "self_or_owner" },
  sessions_revoke: { roles: everyone, subject: "self_or_owner" },
  connection_authorize: { ...personal, browserOnly: true },
  session_logout: { ...personal, browserOnly: true },
} as const satisfies Record<string, Rule>;
export type Action = keyof typeof ACTIONS;
export interface PermissionIdentity {
  memberId: string;
  householdId: string;
  role: Role;
  ceiling?: Role;
  kind: "browser" | "delegated";
}
export interface ActionSubject {
  householdId: string;
  memberId?: string;
}
const HANDOFF_ACTIONS: readonly Action[] = [
  "member_access_setup",
  "member_password_reset",
  "account_password_change",
  "notification_device_setup",
];
export function permitsHandoff(
  identity: PermissionIdentity,
  action: Action,
  subject: ActionSubject,
): boolean {
  return (
    HANDOFF_ACTIONS.includes(action) &&
    policyPermits(identity, action, subject, true)
  );
}
export function permits(
  identity: PermissionIdentity,
  action: Action,
  subject: ActionSubject,
): boolean {
  return policyPermits(identity, action, subject, false);
}
function policyPermits(
  identity: PermissionIdentity,
  action: Action,
  subject: ActionSubject,
  handoff: boolean,
): boolean {
  const rule: Rule | undefined = Object.hasOwn(ACTIONS, action)
    ? ACTIONS[action]
    : undefined;
  if (!rule || (identity.kind === "delegated" && !identity.ceiling))
    return false;
  if (
    identity.householdId !== subject.householdId ||
    (rule.browserOnly && identity.kind !== "browser" && !handoff)
  )
    return false;
  const roleAllows = (role: Role) =>
    rule.roles.includes(role) &&
    (!rule.subject ||
      subject.memberId === identity.memberId ||
      (rule.subject === "self_or_owner" && role === "owner"));
  return (
    roleAllows(identity.role) &&
    (!identity.ceiling || roleAllows(identity.ceiling))
  );
}
export function capabilities(
  identity: PermissionIdentity,
  subject: ActionSubject = {
    householdId: identity.householdId,
    memberId: identity.memberId,
  },
): Action[] {
  return (Object.keys(ACTIONS) as Action[]).filter((action) =>
    permits(identity, action, subject),
  );
}

export function httpAction(method: string, path: string): Action | undefined {
  const route = path.replace(/^\/api\/v1/, "");
  if (route === "/sync")
    return method === "POST" ? "inventory_update" : undefined;
  if (route === "/auth/password") return "account_password_change";
  if (route === "/auth/logout") return "session_logout";
  if (route === "/export") return "inventory_export";
  if (route === "/activity" || /^\/items\/[^/]+\/activity$/.test(route))
    return "activity_list";
  if (
    route === "/notifications/config" ||
    route.includes("/subscriptions/current") ||
    route.endsWith("/delivery-check")
  )
    return "notification_device_setup";
  if (route === "/notifications/preferences")
    return method === "GET"
      ? "notification_preferences_get"
      : "notification_preferences_set";
  if (route === "/notifications") return "notifications_list";
  if (/^\/notifications\/[^/]+$/.test(route)) return "notifications_mark_read";
  if (route === "/members")
    return method === "GET" ? "members_list" : "member_access_setup";
  if (/^\/members\/[^/]+\/password$/.test(route))
    return "member_password_reset";
  if (/^\/members\/[^/]+$/.test(route)) return "members_update";
  if (/^\/meals\/[^/]+\/attendance$/.test(route)) return "meal_attendance_set";
  if (/^\/items\/[^/]+\/events$/.test(route))
    return method === "GET" ? "inventory_events" : "inventory_stock";
  for (const [prefix, domain] of [
    ["items", "inventory"],
    ["expenses", "expenses"],
    ["recipes", "recipes"],
    ["meals", "meals"],
    ["contacts", "contacts"],
  ] as const) {
    if (!new RegExp(`^/${prefix}(?:/[^/]+)?(?:/restore)?$`).test(route))
      continue;
    const part =
      method === "GET"
        ? route === `/${prefix}`
          ? "list"
          : "get"
        : route.endsWith("/restore")
          ? "restore"
          : method === "POST"
            ? "create"
            : method === "DELETE"
              ? "archive"
              : "update";
    const action = `${domain}_${part}` as Action;
    if (action in ACTIONS) return action;
  }
  return undefined;
}
export function commandAction(entityType: string, action: string): Action {
  const verb = action.split(".").at(-1)!;
  const suffix = (
    {
      created: "create",
      updated: "update",
      archived: "archive",
      restored: "restore",
      cancelled: "cancel",
    } as Record<string, string>
  )[verb];
  if (entityType === "meal_attendance") return "meal_attendance_set";
  if (entityType === "inventory_item")
    return action.includes(".stock.")
      ? "inventory_stock"
      : (`inventory_${suffix}` as Action);
  if (entityType === "expense_rule") return `expenses_${suffix}` as Action;
  if (entityType === "member") return "members_update";
  return `${({ recipe: "recipes", meal: "meals", contact: "contacts" } as Record<string, string>)[entityType]}_${suffix}` as Action;
}

/** Available invitations to direct interaction, separate from executable actions. */
export function handoffCapabilities(
  identity: PermissionIdentity,
  subject: ActionSubject = {
    householdId: identity.householdId,
    memberId: identity.memberId,
  },
): Action[] {
  return HANDOFF_ACTIONS.filter((action) =>
    permitsHandoff(identity, action, subject),
  );
}
