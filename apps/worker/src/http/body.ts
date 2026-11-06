import type { z } from "zod";
import { ValidationError } from "../platform/errors";
import type { commandContext } from "./request-context";

const MAX_BODY_BYTES = 64 * 1024;

export async function parsedJSON<T extends z.ZodType>(
  context: Parameters<typeof commandContext>[0],
  schema: T,
): Promise<z.infer<T>> {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) throw new ValidationError("body", "must be 64 KB or smaller");
  let body: unknown;
  try {
    const reader = context.req.raw.body?.getReader();
    if (!reader) throw new ValidationError("body", "must contain valid JSON");
    const bytes = new Uint8Array(MAX_BODY_BYTES);
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (length + chunk.value.byteLength > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ValidationError("body", "must be 64 KB or smaller");
        }
        bytes.set(chunk.value, length);
        length += chunk.value.byteLength;
      }
    } finally { reader.releaseLock(); }
    body = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("body", "must contain valid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.path.join(".") || "body", issue?.message ?? "is invalid");
  }
  return parsed.data;
}
