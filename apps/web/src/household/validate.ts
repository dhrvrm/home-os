import type {
  Contact,
  Meal,
  Recipe,
  HouseholdNotification,
  NotificationPreferences,
} from "./types";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const stringFields = (value: ObjectValue, fields: string[]) =>
  fields.every((key) => typeof value[key] === "string");
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
function timezone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
const record = (value: unknown): value is ObjectValue =>
  object(value) &&
  stringFields(value, ["id", "householdId", "createdAt", "updatedAt"]) &&
  number(value.version) &&
  timestamp(value.createdAt) &&
  timestamp(value.updatedAt);
const ingredients = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      object(item) &&
      stringFields(item, ["name", "unit"]) &&
      (item.quantity === null || number(item.quantity)) &&
      (item.inventoryItemId === null ||
        typeof item.inventoryItemId === "string"),
  );
export function isRecipe(value: unknown): value is Recipe {
  return (
    record(value) &&
    stringFields(value, ["name", "description", "instructions"]) &&
    number(value.servings) &&
    strings(value.labels) &&
    ingredients(value.ingredients) &&
    (value.archivedAt === null || typeof value.archivedAt === "string") &&
    object(value.availability) &&
    ["ready", "missing", "unknown"].includes(
      String(value.availability.state),
    ) &&
    Array.isArray(value.availability.ingredients) &&
    value.availability.ingredients.every(
      (item) =>
        object(item) &&
        number(item.index) &&
        stringFields(item, ["state", "reason", "unit"]) &&
        ["sufficient", "missing", "unknown"].includes(String(item.state)) &&
        (item.availableQuantity === null || number(item.availableQuantity)) &&
        (item.inventoryItemId === null ||
          typeof item.inventoryItemId === "string"),
    )
  );
}
const attendance = (value: unknown) =>
  object(value) &&
  stringFields(value, ["memberId", "memberName"]) &&
  ["yes", "no", "pending"].includes(String(value.response)) &&
  number(value.responseVersion) &&
  number(value.announcementVersion) &&
  typeof value.needsReconfirmation === "boolean";
export function isMeal(value: unknown): value is Meal {
  return (
    record(value) &&
    stringFields(value, [
      "title",
      "cookingAt",
      "timezone",
      "reminderAt",
      "notes",
    ]) &&
    timezone(value.timezone) &&
    Number.isFinite(Date.parse(value.cookingAt as string)) &&
    number(value.reminderMinutesBefore) &&
    number(value.announcementVersion) &&
    ["scheduled", "cancelled"].includes(String(value.status)) &&
    Array.isArray(value.recipes) &&
    value.recipes.every(
      (item) =>
        object(item) &&
        stringFields(item, [
          "sourceRecipeId",
          "name",
          "instructions",
          "description",
        ]) &&
        number(item.sourceRecipeVersion) &&
        number(item.servings) &&
        ingredients(item.ingredients) &&
        strings(item.labels),
    ) &&
    object(value.attendance) &&
    object(value.attendance.counts) &&
    ["yes", "no", "pending", "total"].every((key) =>
      number(
        (value.attendance as ObjectValue).counts &&
          ((value.attendance as ObjectValue).counts as ObjectValue)[key],
      ),
    ) &&
    Array.isArray(value.attendance.participants) &&
    value.attendance.participants.every(attendance) &&
    (value.myAttendance === null || attendance(value.myAttendance))
  );
}
export function isContact(value: unknown): value is Contact {
  return (
    record(value) &&
    stringFields(value, [
      "name",
      "role",
      "phone",
      "email",
      "address",
      "notes",
    ]) &&
    strings(value.labels) &&
    (value.archivedAt === null || typeof value.archivedAt === "string")
  );
}
export function recipesData(value: unknown): value is { recipes: Recipe[] } {
  return (
    object(value) &&
    Array.isArray(value.recipes) &&
    value.recipes.every(isRecipe)
  );
}
export function contactsData(value: unknown): value is { contacts: Contact[] } {
  return (
    object(value) &&
    Array.isArray(value.contacts) &&
    value.contacts.every(isContact)
  );
}
export function mealsData(
  value: unknown,
): value is { meals: Meal[]; timezone: string } {
  return (
    object(value) &&
    timezone(value.timezone) &&
    Array.isArray(value.meals) &&
    value.meals.every(isMeal)
  );
}
export function mealData(
  value: unknown,
): value is { meal: Meal; timezone: string } {
  return object(value) && timezone(value.timezone) && isMeal(value.meal);
}
export function notificationsData(
  value: unknown,
): value is { notifications: HouseholdNotification[]; unreadCount: number } {
  return (
    object(value) &&
    number(value.unreadCount) &&
    Array.isArray(value.notifications) &&
    value.notifications.every(
      (item) =>
        object(item) &&
        stringFields(item, [
          "id",
          "title",
          "body",
          "mealId",
          "url",
          "createdAt",
        ]) &&
        number(item.announcementVersion) &&
        (item.readAt === null || typeof item.readAt === "string"),
    )
  );
}
export function preferencesData(
  value: unknown,
): value is { preferences: NotificationPreferences } {
  return (
    object(value) &&
    object(value.preferences) &&
    typeof value.preferences.mealReminders === "boolean" &&
    typeof value.preferences.pushEnabled === "boolean"
  );
}
