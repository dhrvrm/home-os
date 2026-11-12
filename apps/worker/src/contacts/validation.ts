import { z } from "zod";
import { ValidationError } from "../platform/errors";

export const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().max(120).optional(),
    phone: z
      .string()
      .trim()
      .max(40)
      .refine(
        (value) => !value || /^\+?[\d ()\-.]+$/.test(value),
        "enter a phone number",
      )
      .transform((value) => value.replace(/[ ()\-.]/g, ""))
      .refine(
        (value) => !value || /^\+?\d{3,20}$/.test(value),
        "enter a phone number",
      )
      .optional(),
    email: z
      .string()
      .trim()
      .max(254)
      .refine(
        (value) =>
          !value ||
          /^[A-Za-z0-9.!#$&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
            value,
          ),
        "enter a valid email address",
      )
      .optional(),
    address: z.string().trim().max(500).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();
export const contactUpdateSchema = contactSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "provide fields to change");
export const identifier = z.string().trim().min(1).max(128);

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
