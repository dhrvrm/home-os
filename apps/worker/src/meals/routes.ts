import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { currentMember } from "../auth/session";
import { success } from "../http/envelope";
import { parsedJSON } from "../http/body";
import { requiredOperationCommandContext as command } from "../http/request-context";
import { ValidationError } from "../platform/errors";
import { D1MealRepository } from "./d1-repository";
import { MealService } from "./service";
import {
  archivedFilter,
  attendanceSchema,
  identifier,
  mealSchema,
  mealUpdateSchema,
  recipeSchema,
  recipeUpdateSchema,
  validate,
} from "./validation";

function service(context: Context<{ Bindings: Env }>): MealService {
  return new MealService(new D1MealRepository(context.env.DB));
}

export function createMealRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get("/recipes", async (context) => {
    const recipes = await service(context).listRecipes(
      currentMember(context).householdId,
      {
        search: context.req.query("search"),
        archived: archivedFilter(context.req.query("archived")),
      },
    );
    return success(context, { recipes });
  });
  routes.get("/recipes/:id", async (context) => {
    const recipe = await service(context).getRecipe(
      currentMember(context).householdId,
      validate(identifier, context.req.param("id")),
    );
    return success(context, { recipe });
  });
  routes.post("/recipes", async (context) => {
    const recipe = await service(context).createRecipe(
      command(context),
      await parsedJSON(context, recipeSchema),
    );
    return success(context, { recipe }, 201);
  });
  routes.patch("/recipes/:id", async (context) => {
    const recipe = await service(context).updateRecipe(
      command(context),
      validate(identifier, context.req.param("id")),
      await parsedJSON(context, recipeUpdateSchema),
    );
    return success(context, { recipe });
  });
  routes.delete("/recipes/:id", async (context) => {
    await parsedJSON(context, z.object({}).strict(), { allowEmpty: true });
    const recipe = await service(context).archiveRecipe(
      command(context),
      validate(identifier, context.req.param("id")),
    );
    return success(context, { recipe });
  });
  routes.post("/recipes/:id/restore", async (context) => {
    await parsedJSON(context, z.object({}).strict(), { allowEmpty: true });
    const recipe = await service(context).restoreRecipe(
      command(context),
      validate(identifier, context.req.param("id")),
    );
    return success(context, { recipe });
  });
  routes.get("/meals", async (context) => {
    const from = context.req.query("from"),
      to = context.req.query("to");
    if (!from || !to)
      throw new ValidationError("from", "provide from and exclusive to dates");
    const include = context.req.query("includeCancelled");
    if (include !== undefined && include !== "true" && include !== "false") {
      throw new ValidationError("includeCancelled", "must be true or false");
    }
    const member = currentMember(context);
    return success(
      context,
      await service(context).listMeals(member.householdId, member.id, {
        from,
        to,
        includeCancelled: include === "true",
      }),
    );
  });
  routes.get("/meals/:id", async (context) => {
    const member = currentMember(context);
    return success(context, {
      meal: await service(context).getMeal(
        member.householdId,
        validate(identifier, context.req.param("id")),
        member.id,
      ),
      timezone: await service(context).timezone(member.householdId),
    });
  });
  routes.post("/meals", async (context) => {
    const meal = await service(context).createMeal(
      command(context),
      await parsedJSON(context, mealSchema),
    );
    return success(context, { meal }, 201);
  });
  routes.patch("/meals/:id", async (context) => {
    const meal = await service(context).updateMeal(
      command(context),
      validate(identifier, context.req.param("id")),
      await parsedJSON(context, mealUpdateSchema),
    );
    return success(context, { meal });
  });
  routes.put("/meals/:id/attendance", async (context) => {
    const meal = await service(context).respond(
      command(context),
      validate(identifier, context.req.param("id")),
      await parsedJSON(context, attendanceSchema),
    );
    return success(context, { meal });
  });
  return routes;
}
