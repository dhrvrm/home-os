import type { z } from "zod";
import { ValidationError } from "../platform/errors";

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
