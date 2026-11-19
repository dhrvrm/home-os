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

/** Count streamed bytes before parsing, regardless of declared or missing length. */
export async function boundedRequestBody(request: Request, maximum: number, tooLarge: () => HomeOSError): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(request.headers.get('content-length')) > maximum) throw tooLarge();
  // Grow only as needed, retaining a single bounded buffer for ordinary requests.
  let bytes = new Uint8Array(Math.min(maximum, 64 * 1024));
  const reader = request.body?.getReader();
  let length = 0;
  if (reader) try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const nextLength = length + chunk.value.byteLength;
      if (nextLength > maximum) { await reader.cancel(); throw tooLarge(); }
      if (nextLength > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(maximum, Math.max(nextLength, bytes.byteLength * 2)));
        expanded.set(bytes.subarray(0, length));
        bytes = expanded;
      }
      bytes.set(chunk.value, length); length = nextLength;
    }
  } finally { reader.releaseLock(); }
  return bytes.slice(0, length);
}
export function decodeRequestUTF8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
/** Financial HTTP bodies are bounded before their JSON parser. */
export function boundedLedgerBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  return boundedRequestBody(request, 64 * 1024, () => new HomeOSError('Ledger requests must be at most 64 KiB', 'payload_too_large', 413));
}
export async function boundedLedgerJSON(request: Request, allowEmpty = false): Promise<unknown> {
  const bytes = await boundedLedgerBody(request);
  try { return allowEmpty && bytes.byteLength === 0 ? {} : JSON.parse(decodeRequestUTF8(bytes)); }
  catch { throw new ValidationError('body', 'must contain valid JSON'); }
}
