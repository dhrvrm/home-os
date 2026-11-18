import { Hono } from "hono";
import { createExpenseInput, updateExpenseInput } from "../expenses/catalog/validation";
import type { Env } from "../env";
import { D1ExpenseRepository } from "../expenses/catalog/d1-repository";
import { ExpenseService } from "../expenses/catalog/service";
import type { ArchivedFilter } from "../expenses/catalog/model";
import { ValidationError } from "../platform/errors";
import { parsedJSON } from "./body";
import { commandContext } from "./request-context";
import { success } from "./envelope";

export function createExpenseRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/expenses", async (context) => {
    const archived = context.req.query("archived") || "exclude";
    if (archived !== "exclude" && archived !== "only" && archived !== "include") {
      throw new ValidationError("archived", "must be exclude, only, or include");
    }
    const rules = await expenseService(context.env.DB).listRules(
      context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
      { archived: archived as ArchivedFilter },
    );
    return success(context, { rules });
  });

  routes.post("/expenses", async (context) => {
    const input = await parsedJSON(context, createExpenseInput);
    const rule = await expenseService(context.env.DB).createRule(commandContext(context), input);
    return success(context, { rule }, 201);
  });

  routes.get("/expenses/:id", async (context) => {
    const rule = await expenseService(context.env.DB).getRule(
      context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID,
      context.req.param("id"),
    );
    return success(context, { rule });
  });

  routes.patch("/expenses/:id", async (context) => {
    const input = await parsedJSON(context, updateExpenseInput);
    const rule = await expenseService(context.env.DB).updateRule(
      commandContext(context),
      context.req.param("id"),
      input,
    );
    return success(context, { rule });
  });

  routes.delete("/expenses/:id", async (context) => {
    const rule = await expenseService(context.env.DB).archiveRule(
      commandContext(context),
      context.req.param("id"),
    );
    return success(context, { rule });
  });

  routes.post("/expenses/:id/restore", async (context) => {
    const rule = await expenseService(context.env.DB).restoreRule(
      commandContext(context),
      context.req.param("id"),
    );
    return success(context, { rule });
  });

  return routes;
}

function expenseService(database: D1Database): ExpenseService {
  return new ExpenseService(new D1ExpenseRepository(database));
}
