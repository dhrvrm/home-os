import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface APIErrorBody {
  code: string;
  message: string;
  field?: string;
}

export interface Envelope<T> {
  data: T | null;
  error: APIErrorBody | null;
}

export function success<T>(context: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return context.json<Envelope<T>>({ data, error: null }, status);
}

export function failure(context: Context, error: APIErrorBody, status: ContentfulStatusCode): Response {
  return context.json<Envelope<never>>({ data: null, error }, status);
}
