import { ValidationError } from "../platform/errors";
export { validate } from "../platform/validation";

export function archivedFilter(
  value: string | undefined,
): "exclude" | "only" | "include" {
  if (!value) return "exclude";
  if (value !== "exclude" && value !== "only" && value !== "include") {
    throw new ValidationError("archived", "must be exclude, only or include");
  }
  return value;
}
