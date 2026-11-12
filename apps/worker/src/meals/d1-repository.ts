import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../platform/errors";
import {
  commandGuard,
  commitCommand,
  type HouseholdCommand,
} from "../platform/household-command";
import type {
  AttendanceInput,
  Meal,
  MealAttendance,
  Recipe,
  RecipeFilter,
  RecipeIngredient,
  StoredMeal,
  StoredRecipe,
} from "./model";

interface RecipeRow {
  id: string;
  household_id: string;
  name: string;
  description: string;
  servings: number;
  ingredients_json: string;
  instructions: string;
  labels_json: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
interface MealRow {
  id: string;
  household_id: string;
  title: string;
  cooking_at: string;
  timezone: string;
  reminder_minutes_before: number;
  reminder_at: string;
  notes: string;
  recipes_json: string;
  status: StoredMeal["status"];
  version: number;
  announcement_version: number;
  created_at: string;
  updated_at: string;
}
interface AttendanceRow {
  member_id: string;
  display_name: string;
  response: MealAttendance["response"] | null;
  announcement_version: number | null;
  response_version: number | null;
  updated_at: string | null;
}
interface InventoryRow {
  id: string;
  unit: string;
  tracking_mode: string;
  quantity: number;
  stock_level: string;
  archived_at: string | null;
}

function recipeRow(row: RecipeRow): StoredRecipe {
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    description: row.description,
    servings: row.servings,
    ingredients: JSON.parse(row.ingredients_json),
    instructions: row.instructions,
    labels: JSON.parse(row.labels_json),
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mealRow(row: MealRow): StoredMeal {
  return {
    id: row.id,
    householdId: row.household_id,
    title: row.title,
    cookingAt: row.cooking_at,
    timezone: row.timezone,
    reminderMinutesBefore: row.reminder_minutes_before,
    reminderAt: row.reminder_at,
    notes: row.notes,
    recipes: JSON.parse(row.recipes_json),
    status: row.status,
    version: row.version,
    announcementVersion: row.announcement_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class D1MealRepository {
  constructor(readonly database: D1Database) {}

  async timezone(householdId: string): Promise<string> {
    const row = await this.database
      .prepare("SELECT timezone FROM households WHERE id = ?")
      .bind(householdId)
      .first<{ timezone: string }>();
    if (!row) throw new NotFoundError("household", householdId);
    return row.timezone;
  }

  async getRecipe(householdId: string, id: string): Promise<StoredRecipe> {
    const row = await this.database
      .prepare("SELECT * FROM recipes WHERE household_id = ? AND id = ?")
      .bind(householdId, id)
      .first<RecipeRow>();
    if (!row) throw new NotFoundError("recipe", id);
    return recipeRow(row);
  }

  async listRecipes(
    householdId: string,
    filter: RecipeFilter,
  ): Promise<StoredRecipe[]> {
    const rows = await this.database
      .prepare(
        "SELECT * FROM recipes WHERE household_id = ? ORDER BY name COLLATE NOCASE, id",
      )
      .bind(householdId)
      .all<RecipeRow>();
    const query = filter.search?.trim().toLocaleLowerCase();
    return rows.results.map(recipeRow).filter((recipe) => {
      const lifecycle =
        filter.archived === "include" ||
        (filter.archived === "only") === !!recipe.archivedAt;
      const text = [
        recipe.name,
        recipe.description,
        ...recipe.labels,
        ...recipe.ingredients.map((ingredient) => ingredient.name),
      ];
      return (
        lifecycle &&
        (!query || text.join(" ").toLocaleLowerCase().includes(query))
      );
    });
  }

  async validateLinks(
    householdId: string,
    ingredients: RecipeIngredient[],
  ): Promise<void> {
    const linked = new Set(
      ingredients.flatMap((ingredient) =>
        ingredient.inventoryItemId ? [ingredient.inventoryItemId] : [],
      ),
    );
    if (!linked.size) return;
    const rows = await this.database
      .prepare(
        `SELECT id FROM inventory_items WHERE household_id = ? AND id IN (${[...linked].map(() => "?").join(",")}) AND archived_at IS NULL`,
      )
      .bind(householdId, ...linked)
      .all<{ id: string }>();
    if (rows.results.length !== linked.size)
      throw new ValidationError(
        "ingredients",
        "select an active inventory item from this household",
      );
  }

  async inventoryStock(
    householdId: string,
  ): Promise<Map<string, InventoryRow>> {
    const rows = await this.database
      .prepare(
        "SELECT id, unit, tracking_mode, quantity, stock_level, archived_at FROM inventory_items WHERE household_id = ?",
      )
      .bind(householdId)
      .all<InventoryRow>();
    return new Map(rows.results.map((row) => [row.id, row]));
  }

  async withAvailability(
    recipe: StoredRecipe,
    inventory?: ReadonlyMap<string, InventoryRow>,
  ): Promise<Recipe> {
    const stock = inventory ?? (await this.inventoryStock(recipe.householdId));
    const demand = new Map<string, { quantity: number; terms: number }>();
    for (const ingredient of recipe.ingredients) {
      const item = ingredient.inventoryItemId
        ? stock.get(ingredient.inventoryItemId)
        : undefined;
      if (
        item &&
        ingredient.quantity !== null &&
        ingredient.unit &&
        ingredient.unit === item.unit
      ) {
        const current = demand.get(item.id) ?? { quantity: 0, terms: 0 };
        demand.set(item.id, {
          quantity: current.quantity + ingredient.quantity,
          terms: current.terms + 1,
        });
      }
    }
    const ingredients = recipe.ingredients.map((ingredient, index) => {
      const item = ingredient.inventoryItemId
        ? stock.get(ingredient.inventoryItemId)
        : undefined;
      const base = {
        index,
        inventoryItemId: ingredient.inventoryItemId,
        unit: ingredient.unit,
        availableQuantity:
          item?.tracking_mode === "exact" ? item.quantity : null,
      };
      if (!item || item.archived_at) {
        return {
          ...base,
          state: "unknown" as const,
          reason: ingredient.inventoryItemId
            ? "Linked inventory item is unavailable"
            : "Ingredient is not linked to inventory",
        };
      }
      if (
        item.stock_level === "out" ||
        (item.tracking_mode === "exact" && item.quantity === 0)
      ) {
        return {
          ...base,
          state: "missing" as const,
          reason: "Linked inventory is out of stock",
        };
      }
      if (item.tracking_mode !== "exact") {
        return {
          ...base,
          state: "unknown" as const,
          reason: "Stock is tracked by level rather than exact quantity",
        };
      }
      if (
        ingredient.quantity === null ||
        !ingredient.unit ||
        ingredient.unit !== item.unit
      ) {
        return {
          ...base,
          state: "unknown" as const,
          reason:
            "A matching unit and positive ingredient quantity are required",
        };
      }
      const combined = demand.get(item.id);
      const requiredQuantity = combined?.quantity ?? ingredient.quantity;
      // Addition can exceed an equal decimal stock value by a few rounding bits.
      // Scale the bound to this sum; infinity and actual shortfalls stay missing.
      const sufficient =
        item.quantity >= requiredQuantity ||
        (Number.isFinite(requiredQuantity) &&
          requiredQuantity - item.quantity <=
            Number.EPSILON *
              Math.max(requiredQuantity, item.quantity) *
              (combined?.terms ?? 1));
      return {
        ...base,
        state: sufficient ? ("sufficient" as const) : ("missing" as const),
        reason: sufficient
          ? "Exact stock covers this ingredient"
          : "Exact stock is below the requested quantity",
      };
    });
    return {
      ...recipe,
      availability: {
        state: ingredients.some((ingredient) => ingredient.state === "missing")
          ? "missing"
          : ingredients.length > 0 &&
              ingredients.every(
                (ingredient) => ingredient.state === "sufficient",
              )
            ? "ready"
            : "unknown",
        ingredients,
      },
    };
  }

  async saveRecipe(
    recipe: Recipe,
    command: HouseholdCommand,
    create: boolean,
  ): Promise<Recipe> {
    const values = [
      recipe.name,
      recipe.description,
      recipe.servings,
      JSON.stringify(recipe.ingredients),
      recipe.instructions,
      JSON.stringify(recipe.labels),
      recipe.version,
      recipe.updatedAt,
      recipe.archivedAt,
    ];
    const statements = create
      ? [
          this.database
            .prepare(
              `INSERT INTO recipes (name, description, servings, ingredients_json, instructions, labels_json, version,
                              updated_at, archived_at, id, household_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...values, recipe.id, recipe.householdId, recipe.createdAt),
        ]
      : [
          commandGuard(
            this.database,
            command,
            command.context.expectedVersion!,
            "SELECT version FROM recipes WHERE household_id = ? AND id = ?",
            [recipe.householdId, recipe.id],
          ),
          this.database
            .prepare(
              `UPDATE recipes SET name = ?, description = ?, servings = ?, ingredients_json = ?, instructions = ?,
                            labels_json = ?, version = ?, updated_at = ?, archived_at = ?
         WHERE household_id = ? AND id = ? AND version = ?`,
            )
            .bind(
              ...values,
              recipe.householdId,
              recipe.id,
              command.context.expectedVersion!,
            ),
        ];
    return commitCommand(
      this.database,
      command,
      recipe,
      recipe.id,
      recipe.updatedAt,
      statements,
      async () => {
        if (!create) {
          const current = await this.getRecipe(recipe.householdId, recipe.id);
          if (current.version !== command.context.expectedVersion) {
            throw new ConflictError(
              "recipe",
              recipe.id,
              command.context.expectedVersion!,
              current.version,
              await this.withAvailability(current),
            );
          }
        }
      },
    );
  }

  async getMeal(householdId: string, id: string): Promise<StoredMeal> {
    const row = await this.database
      .prepare("SELECT * FROM meals WHERE household_id = ? AND id = ?")
      .bind(householdId, id)
      .first<MealRow>();
    if (!row) throw new NotFoundError("meal", id);
    return mealRow(row);
  }

  async listMeals(
    householdId: string,
    from: string,
    to: string,
    includeCancelled: boolean,
  ): Promise<StoredMeal[]> {
    const rows = await this.database
      .prepare(
        `SELECT * FROM meals WHERE household_id = ? AND cooking_at >= ? AND cooking_at < ?
       AND (? = 1 OR status = 'scheduled') ORDER BY cooking_at, id`,
      )
      .bind(householdId, from, to, includeCancelled ? 1 : 0)
      .all<MealRow>();
    return rows.results.map(mealRow);
  }

  private attendanceStatement(meal: StoredMeal): D1PreparedStatement {
    return this.database
      .prepare(
        `SELECT m.id AS member_id, m.display_name, a.response, a.announcement_version, a.response_version, a.updated_at
       FROM members m LEFT JOIN meal_attendance a
         ON a.member_id = m.id AND a.household_id = m.household_id AND a.meal_id = ?
       WHERE m.household_id = ? AND m.archived_at IS NULL AND m.role IN ('owner', 'member')
       ORDER BY m.display_name, m.id`,
      )
      .bind(meal.id, meal.householdId);
  }

  async withAttendanceForMeals(
    meals: StoredMeal[],
    memberId: string,
  ): Promise<Meal[]> {
    if (!meals.length) return [];
    const rows = await this.database.batch<AttendanceRow>(
      meals.map((meal) => this.attendanceStatement(meal)),
    );
    return meals.map((meal, index) =>
      this.attendanceProjection(meal, memberId, rows[index]!.results),
    );
  }

  async withAttendance(
    meal: StoredMeal,
    memberId: string,
    override?: MealAttendance,
  ): Promise<Meal> {
    const rows = await this.attendanceStatement(meal).all<AttendanceRow>();
    return this.attendanceProjection(meal, memberId, rows.results, override);
  }

  private attendanceProjection(
    meal: StoredMeal,
    memberId: string,
    rows: AttendanceRow[],
    override?: MealAttendance,
  ): Meal {
    const participants = rows.map((row) => {
      if (override?.memberId === row.member_id) return override;
      const answered = row.announcement_version ?? 0;
      return {
        memberId: row.member_id,
        memberName: row.display_name,
        response:
          answered === meal.announcementVersion
            ? (row.response ?? "pending")
            : "pending",
        announcementVersion: answered,
        responseVersion: row.response_version ?? 0,
        needsReconfirmation:
          answered > 0 && answered !== meal.announcementVersion,
        updatedAt: row.updated_at,
      } satisfies MealAttendance;
    });
    const counts = { yes: 0, no: 0, pending: 0, total: participants.length };
    for (const participant of participants) counts[participant.response]++;
    return {
      ...meal,
      attendance: { participants, counts },
      myAttendance:
        participants.find((participant) => participant.memberId === memberId) ??
        null,
    };
  }

  async saveMeal(
    meal: Meal,
    command: HouseholdCommand,
    create: boolean,
  ): Promise<Meal> {
    const values = [
      meal.title,
      meal.cookingAt,
      meal.timezone,
      meal.reminderMinutesBefore,
      meal.reminderAt,
      meal.notes,
      JSON.stringify(meal.recipes),
      meal.status,
      meal.version,
      meal.announcementVersion,
      meal.updatedAt,
    ];
    const statements = create
      ? [
          this.database
            .prepare(
              `INSERT INTO meals (title, cooking_at, timezone, reminder_minutes_before, reminder_at, notes,
                            recipes_json, status, version, announcement_version, updated_at, id, household_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(...values, meal.id, meal.householdId, meal.createdAt),
        ]
      : [
          commandGuard(
            this.database,
            command,
            command.context.expectedVersion!,
            "SELECT version FROM meals WHERE household_id = ? AND id = ?",
            [meal.householdId, meal.id],
          ),
          this.database
            .prepare(
              `UPDATE meals SET title = ?, cooking_at = ?, timezone = ?, reminder_minutes_before = ?, reminder_at = ?,
                          notes = ?, recipes_json = ?, status = ?, version = ?, announcement_version = ?, updated_at = ?
         WHERE household_id = ? AND id = ? AND version = ?`,
            )
            .bind(
              ...values,
              meal.householdId,
              meal.id,
              command.context.expectedVersion!,
            ),
        ];
    return commitCommand(
      this.database,
      command,
      meal,
      meal.id,
      meal.updatedAt,
      statements,
      async () => {
        if (!create) {
          const current = await this.getMeal(meal.householdId, meal.id);
          if (current.version !== command.context.expectedVersion) {
            throw new ConflictError(
              "meal",
              meal.id,
              command.context.expectedVersion!,
              current.version,
              await this.withAttendance(current, command.context.actorId),
            );
          }
        }
      },
    );
  }

  async saveAttendance(
    meal: Meal,
    input: AttendanceInput,
    command: HouseholdCommand,
    now: string,
  ): Promise<Meal> {
    const { householdId, actorId } = command.context;
    const statements = [
      commandGuard(
        this.database,
        command,
        input.expectedResponseVersion,
        `SELECT CASE WHEN status = 'scheduled' AND announcement_version = ? AND cooking_at > ?
          THEN COALESCE((SELECT response_version FROM meal_attendance
                         WHERE household_id = ? AND meal_id = ? AND member_id = ?), 0)
          ELSE -1 END FROM meals WHERE household_id = ? AND id = ?`,
        [
          input.announcementVersion,
          now,
          householdId,
          meal.id,
          actorId,
          householdId,
          meal.id,
        ],
      ),
      this.database
        .prepare(
          `INSERT INTO meal_attendance (meal_id, household_id, member_id, response, announcement_version,
                                      response_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meal_id, member_id) DO UPDATE SET response = excluded.response,
           announcement_version = excluded.announcement_version, response_version = excluded.response_version,
           updated_at = excluded.updated_at`,
        )
        .bind(
          meal.id,
          householdId,
          actorId,
          input.response,
          input.announcementVersion,
          input.expectedResponseVersion + 1,
          now,
          now,
        ),
    ];
    return commitCommand(
      this.database,
      command,
      meal,
      meal.id,
      now,
      statements,
      async () => {
        const latest = await this.withAttendance(
          await this.getMeal(householdId, meal.id),
          actorId,
        );
        if (
          latest.announcementVersion !== input.announcementVersion ||
          latest.myAttendance?.responseVersion !==
            input.expectedResponseVersion ||
          latest.status !== "scheduled" ||
          latest.cookingAt <= now
        ) {
          throw new ConflictError(
            "meal_attendance",
            meal.id,
            input.expectedResponseVersion,
            latest.myAttendance?.responseVersion ?? 0,
            latest,
          );
        }
      },
    );
  }
}
