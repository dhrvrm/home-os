import type { ApplyEventInput, CreateItemInput, InventoryItem, UpdateItemMetadataInput } from "./inventory";

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

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new APIError("The Home OS API is unavailable. Check your connection and try again.", "network_error");
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
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
}

export async function listItems(): Promise<InventoryItem[]> {
  const data = await request<{ items: InventoryItem[] }>("/api/v1/items");
  return data.items;
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
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  return data.item;
}
