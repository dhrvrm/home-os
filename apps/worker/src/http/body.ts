import type { z } from "zod";
import { HomeOSError, ValidationError } from "../platform/errors";
import type { commandContext } from "./request-context";
import { validate } from "./validation";

const MAX_BODY_BYTES = 64 * 1024;

export async function parsedJSON<T extends z.ZodType>(
  context: Parameters<typeof commandContext>[0],
  schema: T,
  options: { allowEmpty?: boolean } = {},
): Promise<z.infer<T>> {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES)
    throw new ValidationError("body", "must be 64 KB or smaller");
  let body: unknown;
  try {
    const reader = context.req.raw.body?.getReader();
    if (!reader) {
      if (!options.allowEmpty)
        throw new ValidationError("body", "must contain valid JSON");
      body = {};
    } else {
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
      } finally {
        reader.releaseLock();
      }
      body =
        length === 0 && options.allowEmpty
          ? {}
          : JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("body", "must contain valid JSON");
  }
  return validate(schema, body);
}

/** Bound raw bytes before any JSON parser, including chunked and escaped input. */
export async function boundedLedgerBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const maximum = 64 * 1024;
  const tooLarge = () => new HomeOSError('Ledger requests must be at most 64 KiB', 'payload_too_large', 413);
  if (Number(request.headers.get('content-length')) > maximum) throw tooLarge();
  const bytes = new Uint8Array(maximum);
  const reader = request.body?.getReader();
  let length = 0;
  if (reader) try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maximum) { await reader.cancel(); throw tooLarge(); }
      bytes.set(chunk.value, length); length += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return bytes.slice(0, length);
}
export async function boundedLedgerJSON(request: Request, allowEmpty = false): Promise<unknown> {
  const bytes = await boundedLedgerBody(request);
  try { return allowEmpty && bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('body', 'must contain valid JSON'); }
}
