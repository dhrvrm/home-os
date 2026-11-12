/** Public cooking DTOs. Keep this module free of server/runtime dependencies. */
export type ArchivedFilter = "exclude" | "only" | "include";
export type AttendanceResponse = "yes" | "no" | "pending";
export type MealStatus = "scheduled" | "cancelled";
export type IngredientAvailabilityState = "sufficient" | "missing" | "unknown";

export interface RecipeIngredientInput {
  name: string;
  quantity?: number | null;
  unit?: string;
  inventoryItemId?: string | null;
}

export interface RecipeIngredient {
  name: string;
  quantity: number | null;
  unit: string;
  inventoryItemId: string | null;
}

export interface IngredientAvailability {
  index: number;
  state: IngredientAvailabilityState;
  reason: string;
  inventoryItemId: string | null;
  availableQuantity: number | null;
  unit: string;
}

export interface RecipeAvailability {
  state: "ready" | "missing" | "unknown";
  ingredients: IngredientAvailability[];
}

export interface RecipeInput {
  name: string;
  description?: string;
  servings: number;
  ingredients: RecipeIngredientInput[];
  instructions: string;
  labels?: string[];
}
export type CreateRecipeInput = RecipeInput;
export type UpdateRecipeInput = Partial<RecipeInput>;

export interface StoredRecipe {
  id: string;
  householdId: string;
  name: string;
  description: string;
  servings: number;
  ingredients: RecipeIngredient[];
  instructions: string;
  labels: string[];
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Recipe extends StoredRecipe {
  availability: RecipeAvailability;
}

export interface RecipeSnapshot {
  sourceRecipeId: string;
  sourceRecipeVersion: number;
  name: string;
  description: string;
  servings: number;
  ingredients: RecipeIngredient[];
  instructions: string;
  labels: string[];
}

export interface MealInput {
  title: string;
  recipeIds: string[];
  cookingAt: string;
  timezone?: string;
  reminderMinutesBefore?: number;
  notes?: string;
}
export type CreateMealInput = MealInput;
export type UpdateMealInput = Partial<MealInput> & { status?: MealStatus };

export interface StoredMeal {
  id: string;
  householdId: string;
  title: string;
  cookingAt: string;
  timezone: string;
  reminderMinutesBefore: number;
  reminderAt: string;
  notes: string;
  recipes: RecipeSnapshot[];
  status: MealStatus;
  version: number;
  announcementVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MealAttendance {
  memberId: string;
  memberName: string;
  /** Effective response to the current announcement; stale assent is pending. */
  response: AttendanceResponse;
  /** Announcement actually answered, or zero before the first response. */
  announcementVersion: number;
  responseVersion: number;
  needsReconfirmation: boolean;
  updatedAt: string | null;
}

export interface AttendanceCounts {
  yes: number;
  no: number;
  pending: number;
  total: number;
}

export interface Meal extends StoredMeal {
  attendance: { participants: MealAttendance[]; counts: AttendanceCounts };
  myAttendance: MealAttendance | null;
}

export interface AttendanceInput {
  response: AttendanceResponse;
  announcementVersion: number;
  expectedResponseVersion: number;
}

export interface MealReminderCandidate {
  /** Opaque position in the cooking-owned due-recipient ordering. */
  cursor?: string;
  mealId: string;
  announcementVersion: number;
  memberId: string;
  title: string;
  recipeNames: string[];
  cookingAt: string;
  reminderAt: string;
  timezone: string;
}

/** The database is bound by the adapter; notification processing consumes meaning. */
export interface MealReminderSource {
  listDueMealReminders(
    householdId: string,
    now: string,
    limit?: number,
    after?: string,
  ): Promise<MealReminderCandidate[]>;
  isMealReminderEligible(
    householdId: string,
    mealId: string,
    announcementVersion: number,
    memberId: string,
    now: string,
  ): Promise<boolean>;
}

export interface RecipeFilter {
  search?: string;
  archived?: ArchivedFilter;
}
export interface MealRange {
  from: string;
  to: string;
  includeCancelled?: boolean;
}
