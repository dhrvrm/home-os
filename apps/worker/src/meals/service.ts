import type { CommandContext } from "../platform/context";
import { ConflictError, ValidationError } from "../platform/errors";
import { createId } from "../platform/ids";
import {
  beginCommand,
  expectedVersion,
  replayCommand,
} from "../platform/household-command";
import { D1MealRepository } from "./d1-repository";
import type {
  AttendanceInput,
  CreateMealInput,
  CreateRecipeInput,
  Meal,
  MealRange,
  Recipe,
  RecipeFilter,
  RecipeIngredientInput,
  RecipeSnapshot,
  StoredMeal,
  StoredRecipe,
  UpdateMealInput,
  UpdateRecipeInput,
} from "./model";
import {
  attendanceSchema,
  mealSchema,
  mealUpdateSchema,
  recipeSchema,
  recipeUpdateSchema,
  validate,
} from "./validation";
import { assertTimezone, cookingInstant, menuBounds } from "./time";

function ingredients(input: RecipeIngredientInput[]) {
  return input.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity ?? null,
    unit: ingredient.unit ?? "",
    inventoryItemId: ingredient.inventoryItemId ?? null,
  }));
}

function snapshot(recipe: StoredRecipe): RecipeSnapshot {
  return {
    sourceRecipeId: recipe.id,
    sourceRecipeVersion: recipe.version,
    name: recipe.name,
    description: recipe.description,
    servings: recipe.servings,
    ingredients: structuredClone(recipe.ingredients),
    instructions: recipe.instructions,
    labels: [...recipe.labels],
  };
}

function dishesContent(recipes: RecipeSnapshot[]): string {
  return JSON.stringify(
    recipes.map(({ sourceRecipeVersion, ...content }) => {
      void sourceRecipeVersion;
      return content;
    }),
  );
}

export class MealService {
  constructor(
    private readonly repository: D1MealRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async listRecipes(
    householdId: string,
    filter: RecipeFilter = {},
  ): Promise<Recipe[]> {
    return Promise.all(
      (await this.repository.listRecipes(householdId, filter)).map((recipe) =>
        this.repository.withAvailability(recipe),
      ),
    );
  }

  async getRecipe(householdId: string, id: string): Promise<Recipe> {
    return this.repository.withAvailability(
      await this.repository.getRecipe(householdId, id),
    );
  }

  async createRecipe(
    context: CommandContext,
    input: CreateRecipeInput,
  ): Promise<Recipe> {
    const data = validate(recipeSchema, input);
    const command = await beginCommand(
      this.repository.database,
      context,
      "recipe",
      "recipes.created",
      undefined,
      data,
    );
    const replay = await replayCommand<Recipe>(
      this.repository.database,
      command,
    );
    if (replay) return replay;
    const now = this.clock();
    const recipe: StoredRecipe = {
      id: createId(),
      householdId: context.householdId,
      name: data.name,
      description: data.description ?? "",
      servings: data.servings,
      ingredients: ingredients(data.ingredients),
      instructions: data.instructions,
      labels: data.labels ?? [],
      version: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.validateLinks(
      context.householdId,
      recipe.ingredients,
    );
    return this.repository.saveRecipe(
      await this.repository.withAvailability(recipe),
      command,
      true,
    );
  }

  updateRecipe(
    context: CommandContext,
    id: string,
    input: UpdateRecipeInput,
  ): Promise<Recipe> {
    return this.changeRecipe(
      context,
      id,
      "updated",
      validate(recipeUpdateSchema, input),
    );
  }

  archiveRecipe(context: CommandContext, id: string): Promise<Recipe> {
    return this.changeRecipe(context, id, "archived", {});
  }

  restoreRecipe(context: CommandContext, id: string): Promise<Recipe> {
    return this.changeRecipe(context, id, "restored", {});
  }

  private async changeRecipe(
    context: CommandContext,
    id: string,
    action: string,
    input: UpdateRecipeInput,
  ): Promise<Recipe> {
    const version = expectedVersion(context);
    const command = await beginCommand(
      this.repository.database,
      context,
      "recipe",
      `recipes.${action}`,
      id,
      input,
    );
    const replay = await replayCommand<Recipe>(
      this.repository.database,
      command,
    );
    if (replay) return replay;
    const current = await this.repository.getRecipe(context.householdId, id);
    if (current.version !== version) {
      throw new ConflictError(
        "recipe",
        id,
        version,
        current.version,
        await this.repository.withAvailability(current),
      );
    }
    if (action === "updated" && current.archivedAt) {
      throw new ValidationError(
        "recipe",
        "restore this recipe before editing it",
      );
    }
    const now = this.clock();
    const next: StoredRecipe = {
      ...current,
      ...input,
      ingredients: input.ingredients
        ? ingredients(input.ingredients)
        : current.ingredients,
      version: version + 1,
      updatedAt: now,
      archivedAt:
        action === "archived"
          ? now
          : action === "restored"
            ? null
            : current.archivedAt,
    };
    if (input.ingredients)
      await this.repository.validateLinks(
        context.householdId,
        next.ingredients,
      );
    return this.repository.saveRecipe(
      await this.repository.withAvailability(next),
      command,
      false,
    );
  }

  async listMeals(
    householdId: string,
    memberId: string,
    range: MealRange,
  ): Promise<{ meals: Meal[]; timezone: string }> {
    const timezone = assertTimezone(
      await this.repository.timezone(householdId),
    );
    const bounds = menuBounds(range.from, range.to, timezone);
    const meals = await this.repository.listMeals(
      householdId,
      bounds.from,
      bounds.to,
      range.includeCancelled ?? false,
    );
    return {
      meals: await Promise.all(
        meals.map((meal) => this.repository.withAttendance(meal, memberId)),
      ),
      timezone,
    };
  }

  async getMeal(
    householdId: string,
    id: string,
    memberId: string,
  ): Promise<Meal> {
    return this.repository.withAttendance(
      await this.repository.getMeal(householdId, id),
      memberId,
    );
  }

  timezone(householdId: string): Promise<string> {
    return this.repository.timezone(householdId);
  }

  private async selected(
    householdId: string,
    ids: string[],
  ): Promise<RecipeSnapshot[]> {
    return Promise.all(
      ids.map(async (id) => {
        const recipe = await this.repository.getRecipe(householdId, id);
        if (recipe.archivedAt)
          throw new ValidationError("recipeIds", "select active recipes");
        return snapshot(recipe);
      }),
    );
  }

  private async zone(householdId: string, supplied?: string): Promise<string> {
    const zone = assertTimezone(await this.repository.timezone(householdId));
    if (supplied !== undefined) {
      assertTimezone(supplied);
      if (supplied !== zone)
        throw new ValidationError("timezone", "use the household timezone");
    }
    return zone;
  }

  async createMeal(
    context: CommandContext,
    input: CreateMealInput,
  ): Promise<Meal> {
    const data = validate(mealSchema, input);
    const command = await beginCommand(
      this.repository.database,
      context,
      "meal",
      "meals.created",
      undefined,
      data,
    );
    // Replay precedes time and lifecycle validation: an accepted command remains accepted after its deadline.
    const replay = await replayCommand<Meal>(this.repository.database, command);
    if (replay) return replay;
    const now = this.clock();
    const timezone = await this.zone(context.householdId, data.timezone);
    const cookingAt = cookingInstant(data.cookingAt, timezone);
    if (cookingAt <= now)
      throw new ValidationError("cookingAt", "choose a future cooking time");
    const lead = data.reminderMinutesBefore ?? 60;
    const meal: StoredMeal = {
      id: createId(),
      householdId: context.householdId,
      title: data.title,
      cookingAt,
      timezone,
      reminderMinutesBefore: lead,
      reminderAt: new Date(Date.parse(cookingAt) - lead * 60000).toISOString(),
      notes: data.notes ?? "",
      recipes: await this.selected(context.householdId, data.recipeIds),
      status: "scheduled",
      version: 1,
      announcementVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.saveMeal(
      await this.repository.withAttendance(meal, context.actorId),
      command,
      true,
    );
  }

  async updateMeal(
    context: CommandContext,
    id: string,
    input: UpdateMealInput,
  ): Promise<Meal> {
    const data = validate(mealUpdateSchema, input);
    const version = expectedVersion(context);
    const command = await beginCommand(
      this.repository.database,
      context,
      "meal",
      "meals.updated",
      id,
      data,
    );
    const replay = await replayCommand<Meal>(this.repository.database, command);
    if (replay) return replay;
    const current = await this.repository.getMeal(context.householdId, id);
    if (current.version !== version) {
      throw new ConflictError(
        "meal",
        id,
        version,
        current.version,
        await this.repository.withAttendance(current, context.actorId),
      );
    }
    const now = this.clock();
    const timezone = await this.zone(context.householdId, data.timezone);
    const cookingAt =
      data.cookingAt === undefined
        ? current.cookingAt
        : cookingInstant(data.cookingAt, timezone);
    if (data.cookingAt !== undefined && cookingAt <= now) {
      throw new ValidationError("cookingAt", "choose a future cooking time");
    }
    if (data.status === "scheduled" && cookingAt <= now) {
      throw new ValidationError(
        "status",
        "a past meal cannot be scheduled again",
      );
    }
    const recipes =
      data.recipeIds === undefined
        ? current.recipes
        : await this.selected(context.householdId, data.recipeIds);
    const changed =
      cookingAt !== current.cookingAt ||
      dishesContent(recipes) !== dishesContent(current.recipes);
    const lead = data.reminderMinutesBefore ?? current.reminderMinutesBefore;
    const next: StoredMeal = {
      ...current,
      title: data.title ?? current.title,
      cookingAt,
      timezone,
      reminderMinutesBefore: lead,
      reminderAt: new Date(Date.parse(cookingAt) - lead * 60000).toISOString(),
      notes: data.notes ?? current.notes,
      recipes,
      status: data.status ?? current.status,
      version: version + 1,
      announcementVersion: current.announcementVersion + (changed ? 1 : 0),
      updatedAt: now,
    };
    return this.repository.saveMeal(
      await this.repository.withAttendance(next, context.actorId),
      command,
      false,
    );
  }

  async respond(
    context: CommandContext,
    id: string,
    input: AttendanceInput,
  ): Promise<Meal> {
    const data = validate(attendanceSchema, input);
    const command = await beginCommand(
      this.repository.database,
      context,
      "meal_attendance",
      "meals.attendance.updated",
      id,
      data,
    );
    const replay = await replayCommand<Meal>(this.repository.database, command);
    if (replay) return replay;
    const current = await this.getMeal(
      context.householdId,
      id,
      context.actorId,
    );
    const now = this.clock();
    if (
      current.announcementVersion !== data.announcementVersion ||
      current.myAttendance?.responseVersion !== data.expectedResponseVersion
    ) {
      throw new ConflictError(
        "meal_attendance",
        id,
        data.expectedResponseVersion,
        current.myAttendance?.responseVersion ?? 0,
        current,
      );
    }
    if (current.status !== "scheduled" || current.cookingAt <= now) {
      throw new ValidationError("meal", "attendance is closed for this meal");
    }
    if (!current.myAttendance)
      throw new ValidationError(
        "member",
        "only active household participants can answer",
      );
    const response = {
      memberId: context.actorId,
      memberName: current.myAttendance.memberName,
      response: data.response,
      announcementVersion: data.announcementVersion,
      responseVersion: data.expectedResponseVersion + 1,
      needsReconfirmation: false,
      updatedAt: now,
    };
    return this.repository.saveAttendance(
      await this.repository.withAttendance(current, context.actorId, response),
      data,
      command,
      now,
    );
  }
}
