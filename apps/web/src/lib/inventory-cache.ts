import type { Cadence, Forecast, InventoryItem } from "./inventory";

const INVENTORY_CACHE_KEY = "home-os:inventory:v1";
const INVENTORY_CACHE_VERSION = 1;

type InventoryCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type CacheClock = Date | (() => Date);

export interface InventoryCache {
  items: InventoryItem[];
  savedAt: string;
}

interface InventoryCachePayload extends InventoryCache {
  version: typeof INVENTORY_CACHE_VERSION;
}

const trackingModes = new Set(["simple", "exact"]);
const stockLevels = new Set(["full", "okay", "low", "out"]);
const confidenceLevels = new Set(["low", "medium", "high"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateForecast(value: unknown): Forecast | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isNonNegativeNumber(value.dailyUsage) ||
    !isNonNegativeNumber(value.daysRemaining) ||
    typeof value.confidence !== "string" ||
    !confidenceLevels.has(value.confidence)
  ) {
    return null;
  }

  return {
    dailyUsage: value.dailyUsage,
    daysRemaining: value.daysRemaining,
    confidence: value.confidence as Forecast["confidence"],
  };
}

function validateCadence(value: unknown): Cadence | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isNonNegativeNumber(value.averageIntervalDays) ||
    !isNonNegativeNumber(value.eventsPerWeek) ||
    !isDateString(value.lastConsumedAt) ||
    typeof value.confidence !== "string" ||
    !confidenceLevels.has(value.confidence)
  ) {
    return null;
  }

  return {
    averageIntervalDays: value.averageIntervalDays,
    eventsPerWeek: value.eventsPerWeek,
    lastConsumedAt: value.lastConsumedAt,
    confidence: value.confidence as Cadence["confidence"],
  };
}

function validateItem(value: unknown): InventoryItem | null {
  if (!isRecord(value)) return null;

  const forecast = validateForecast(value.forecast);
  const cadence = validateCadence(value.cadence);
  if (forecast === null || cadence === null) return null;

  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.category !== "string" ||
    typeof value.location !== "string" ||
    value.location.length === 0 ||
    typeof value.unit !== "string" ||
    value.unit.length === 0 ||
    typeof value.trackingMode !== "string" ||
    !trackingModes.has(value.trackingMode) ||
    !isNonNegativeNumber(value.quantity) ||
    typeof value.stockLevel !== "string" ||
    !stockLevels.has(value.stockLevel) ||
    !isFiniteNumber(value.levelPercent) ||
    value.levelPercent < 0 ||
    value.levelPercent > 100 ||
    !isNonNegativeNumber(value.minQuantity) ||
    !isDateString(value.createdAt) ||
    !isDateString(value.updatedAt) ||
    (value.alternativeNames !== undefined && !isStringArray(value.alternativeNames)) ||
    (value.categories !== undefined && !isStringArray(value.categories))
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    alternativeNames: value.alternativeNames ?? [],
    category: value.category,
    categories: value.categories ?? (value.category ? [value.category] : []),
    location: value.location,
    unit: value.unit,
    trackingMode: value.trackingMode as InventoryItem["trackingMode"],
    quantity: value.quantity,
    stockLevel: value.stockLevel as InventoryItem["stockLevel"],
    levelPercent: value.levelPercent,
    minQuantity: value.minQuantity,
    ...(forecast === undefined ? {} : { forecast }),
    ...(cadence === undefined ? {} : { cadence }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function resolveStorage(storage?: InventoryCacheStorage): InventoryCacheStorage | null {
  if (storage) return storage;

  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function saveInventoryCache(
  items: InventoryItem[],
  storage?: InventoryCacheStorage,
  now: CacheClock = () => new Date(),
): boolean {
  const validatedItems = items.map(validateItem);
  if (validatedItems.some((item) => item === null)) return false;

  const savedAt = (typeof now === "function" ? now() : now).toISOString();
  const payload: InventoryCachePayload = {
    version: INVENTORY_CACHE_VERSION,
    savedAt,
    items: validatedItems as InventoryItem[],
  };

  try {
    const target = resolveStorage(storage);
    if (!target) return false;
    target.setItem(INVENTORY_CACHE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function loadInventoryCache(storage?: InventoryCacheStorage): InventoryCache | null {
  try {
    const target = resolveStorage(storage);
    if (!target) return null;

    const serialized = target.getItem(INVENTORY_CACHE_KEY);
    if (serialized === null) return null;

    const payload: unknown = JSON.parse(serialized);
    if (
      !isRecord(payload) ||
      payload.version !== INVENTORY_CACHE_VERSION ||
      !isDateString(payload.savedAt) ||
      !Array.isArray(payload.items)
    ) {
      return null;
    }

    const items = payload.items.map(validateItem);
    if (items.some((item) => item === null)) return null;

    return { items: items as InventoryItem[], savedAt: payload.savedAt };
  } catch {
    return null;
  }
}

export function clearInventoryCache(storage?: InventoryCacheStorage): boolean {
  try {
    const target = resolveStorage(storage);
    if (!target) return false;
    target.removeItem(INVENTORY_CACHE_KEY);
    return true;
  } catch {
    return false;
  }
}
