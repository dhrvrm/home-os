import type {
  ApplyEventInput,
  CreateItemInput,
  InventoryExport,
  InventoryItem,
  StockEvent,
  UpdateItemInput,
  UpdateItemMetadataInput,
} from "./inventory";
import type { CreateExpenseInput, ExpenseRule, Member, UpdateExpenseInput } from "./expenses";
import { captureAccessProof, signalSessionExpired } from "@/auth/work";

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

export interface MutationRequestOptions extends APIRequestOptions {
  operationId?: string;
  expectedVersion?: number;
  deviceId?: string;
  clientTime?: string;
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 10_000;

export async function request<T>(path: string, init?: RequestInit, options: APIRequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const proof = captureAccessProof();
    const memberId = proof.memberId;
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        ...init,
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(memberId ? { "X-HomeOS-Member": memberId } : {}), ...init?.headers },
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
      if ((response.status === 401 && envelope.error?.code === "unauthorized") || envelope.error?.code === "session_changed") {
        signalSessionExpired(proof);
      }
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

export async function createItem(input: CreateItemInput, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>("/api/v1/items", {
    method: "POST",
    headers: mutationHeaders(options),
    body: JSON.stringify(input),
  }, options);
  return data.item;
}

export async function applyEvent(itemID: string, input: ApplyEventInput, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}/events`, {
    method: "POST",
    headers: mutationHeaders(options),
    body: JSON.stringify(input),
  }, options);
  return data.item;
}

export async function updateItemMetadata(itemID: string, input: UpdateItemMetadataInput, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  return updateItem(itemID, input, options);
}

export async function updateItem(itemID: string, input: UpdateItemInput, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, {
    method: "PATCH",
    headers: mutationHeaders(options),
    body: JSON.stringify(input),
  }, options);
  return data.item;
}

export async function listItemEvents(itemID: string, options?: APIRequestOptions): Promise<StockEvent[]> {
  const data = await request<{ events: StockEvent[] }>(`/api/v1/items/${encodeURIComponent(itemID)}/events`, undefined, options);
  return data.events;
}

export async function archiveItem(itemID: string, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}`, {
    method: "DELETE",
    headers: mutationHeaders(options),
  }, options);
  return data.item;
}

export async function restoreItem(itemID: string, options: MutationRequestOptions = {}): Promise<InventoryItem> {
  const data = await request<{ item: InventoryItem }>(`/api/v1/items/${encodeURIComponent(itemID)}/restore`, {
    method: "POST",
    headers: mutationHeaders(options),
  }, options);
  return data.item;
}

export interface ListExpensesOptions extends APIRequestOptions {
  archived?: "only" | "include";
}

export async function listExpenses(options: ListExpensesOptions = {}): Promise<ExpenseRule[]> {
  const path = options.archived ? `/api/v1/expenses?archived=${options.archived}` : "/api/v1/expenses";
  const data = await request<{ rules: ExpenseRule[] }>(path, undefined, options);
  return data.rules;
}

export async function getExpense(ruleID: string, options?: APIRequestOptions): Promise<ExpenseRule> {
  const data = await request<{ rule: ExpenseRule }>(`/api/v1/expenses/${encodeURIComponent(ruleID)}`, undefined, options);
  return data.rule;
}

export async function createExpense(input: CreateExpenseInput, options: MutationRequestOptions = {}): Promise<ExpenseRule> {
  const data = await request<{ rule: ExpenseRule }>("/api/v1/expenses", {
    method: "POST",
    headers: mutationHeaders(options),
    body: JSON.stringify(input),
  }, options);
  return data.rule;
}

export async function updateExpense(ruleID: string, input: UpdateExpenseInput, options: MutationRequestOptions = {}): Promise<ExpenseRule> {
  const data = await request<{ rule: ExpenseRule }>(`/api/v1/expenses/${encodeURIComponent(ruleID)}`, {
    method: "PATCH",
    headers: mutationHeaders(options),
    body: JSON.stringify(input),
  }, options);
  return data.rule;
}

export async function archiveExpense(ruleID: string, options: MutationRequestOptions = {}): Promise<ExpenseRule> {
  const data = await request<{ rule: ExpenseRule }>(`/api/v1/expenses/${encodeURIComponent(ruleID)}`, {
    method: "DELETE",
    headers: mutationHeaders(options),
  }, options);
  return data.rule;
}

export async function restoreExpense(ruleID: string, options: MutationRequestOptions = {}): Promise<ExpenseRule> {
  const data = await request<{ rule: ExpenseRule }>(`/api/v1/expenses/${encodeURIComponent(ruleID)}/restore`, {
    method: "POST",
    headers: mutationHeaders(options),
  }, options);
  return data.rule;
}

export async function listMembers(options?: APIRequestOptions): Promise<Member[]> {
  const data = await request<{ members: Member[] }>("/api/v1/members", undefined, options);
  return data.members;
}

export async function exportInventory(): Promise<InventoryExport> {
  return request<InventoryExport>("/api/v1/export");
}

function mutationHeaders(options: MutationRequestOptions): HeadersInit {
  return {
    ...(options.operationId ? { "X-Operation-ID": options.operationId } : {}),
    ...(options.expectedVersion !== undefined ? { "If-Match": String(options.expectedVersion) } : {}),
    ...(options.deviceId ? { "X-Device-ID": options.deviceId } : {}),
    ...(options.clientTime ? { "X-Client-Time": options.clientTime } : {}),
  };
}
