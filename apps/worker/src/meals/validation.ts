import { z } from "zod";
import { ValidationError } from "../platform/errors";

export const identifier = z.string().trim().min(1).max(128);
const name = z.string().trim().min(1).max(120);
const labels = z.array(z.string().trim().min(1).max(40)).max(12);
const ingredient = z
  .object({
    name,
    quantity: z.number().finite().positive().nullish(),
    unit: z.string().trim().max(40).optional(),
    inventoryItemId: identifier.nullish(),
  })
  .strict();

export const recipeSchema = z
  .object({
    name,
    description: z.string().trim().max(2000).optional(),
    servings: z.number().int().min(1).max(100),
    ingredients: z.array(ingredient).max(60),
    instructions: z.string().trim().max(12000),
    labels: labels.optional(),
  })
  .strict();
export const recipeUpdateSchema = recipeSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "provide fields to change");

export const mealSchema = z
  .object({
    title: name,
    recipeIds: z
      .array(identifier)
      .min(1)
      .max(12)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "select each dish once",
      ),
    cookingAt: z.string().max(64),
    timezone: z.string().trim().max(100).optional(),
    reminderMinutesBefore: z.number().int().min(1).max(10080).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export const mealUpdateSchema = mealSchema
  .partial()
  .extend({ status: z.enum(["scheduled", "cancelled"]).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "provide fields to change");

export const attendanceSchema = z
  .object({
    response: z.enum(["yes", "no", "pending"]),
    announcementVersion: z.number().int().positive(),
    expectedResponseVersion: z.number().int().min(0),
  })
  .strict();

export function validate<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(
      issue?.path.join(".") || "body",
      issue?.message ?? "is invalid",
    );
  }
  return parsed.data;
}

export function archivedFilter(
  value: string | undefined,
): "exclude" | "only" | "include" {
  if (!value) return "exclude";
  if (value !== "exclude" && value !== "only" && value !== "include") {
    throw new ValidationError("archived", "must be exclude, only or include");
  }
  return value;
}
