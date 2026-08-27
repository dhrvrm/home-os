import type {
  ApplyEventInput,
  CreateItemInput,
  InventoryExport,
  InventoryItem,
  StockEvent,
  UpdateItemInput,
  UpdateItemMetadataInput,
} from "./inventory";

interface APIErrorBody {
  code: string;
  message: string;
  field?: string;
}

interface Envelope<T> {
  data: T | null;
  error: APIErrorBody | null;
}

export class APIError extends Error {
  constructor(
    message: string,
    public readonly code = "request_failed",
    public readonly field?: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export interface APIRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ListItemsOptions extends APIRequestOptions {
  archived?: "only" | "include";
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 10_000;

async function request<T>(path: string, init?: RequestInit, options: APIRequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
    } catch {
      throw requestTransportError(timedOut, options.signal);
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      if (timedOut || options.signal?.aborted) {
        throw requestTransportError(timedOut, options.signal);
      }
      throw new APIError("The server returned an unreadable response.", "invalid_response");
    }

    if (!response.ok || envelope.error) {
      throw new APIError(
        envelope.error?.message ?? "The request could not be completed.",
        envelope.error?.code,
        envelope.error?.field,
      );
    }
    if (envelope.data === null) {
      throw new APIError("The server returned an empty response.", "invalid_response");
    }
    return envelope.data;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function requestTransportError(timedOut: boolean, callerSignal?: AbortSignal): APIError {
  if (timedOut) return new APIError("The Home OS API took too long to respond. Try again.", "timeout");
  if (callerSignal?.aborted) return new APIError("The request was cancelled.", "cancelled");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new APIError("You are offline. Home OS will show the latest saved copy when available.", "offline");
  }
  return new APIError("The Home OS API is unavailable. Check your connection and try again.", "network_error");
}

export async function listItems(options: ListItemsOptions = {}): Promise<InventoryItem[]> {
  const path = options.archived ? `/api/v1/items?archived=${options.archived}` : "/api/v1/items";
  const data = await request<{ items: InventoryItem[] }>(path, undefined, options);
  return data.items;
}

export async function getItem(itemID: string, options?: APIRequestOptions): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, undefined, options);
  return data.item;
}

export async function createItem(input: CreateItemInput): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>("/api/v1/items", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.item;
}

export async function applyEvent(itemID: string, input: ApplyEventInput): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}/events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.item;
}

export async function updateItemMetadata(itemID: string, input: UpdateItemMetadataInput): Promise<InventoryItem> {
  return updateItem(itemID, input);
}

export async function updateItem(itemID: string, input: UpdateItemInput): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return data.item;
}

export async function listItemEvents(itemID: string, options?: APIRequestOptions): Promise<StockEvent[]> {
  const data = await request<{ events: StockEvent[] }>(`/api/v1/items/${encodeURIComponent(itemID)}/events`, undefined, options);
  return data.events;
}

export async function archiveItem(itemID: string): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, { method: "DELETE" });
  return data.item;
}

export async function restoreItem(itemID: string): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}/restore`, { method: "POST" });
  return data.item;
}

export async function exportInventory(): Promise<InventoryExport> {
  return request<InventoryExport>("/api/v1/export");
}
